import Foundation
import Observation
import SwiftChat
import UserNotifications

@MainActor
@Observable
public final class ChatClient {
    private struct MePayload: Decodable, Sendable {
        let user: ChatUser
        let eventSeq: Int

        enum CodingKeys: String, CodingKey {
            case user
            case eventSeq = "event_seq"
        }
    }

    private struct SignedInPayload: Decodable, Sendable {
        let user: ChatUser
        let token: String
    }

    private struct ListPayload: Decodable, Sendable {
        let eventSeq: Int
        let conversations: [Conversation]

        enum CodingKeys: String, CodingKey {
            case eventSeq = "event_seq"
            case conversations
        }
    }

    private struct PagePayload: Decodable, Sendable {
        let messages: [ChatMessage]
        let hasMore: Bool
        let conversation: Conversation?

        enum CodingKeys: String, CodingKey {
            case messages
            case hasMore = "has_more"
            case conversation
        }
    }

    private struct ConversationPayload: Decodable, Sendable {
        let conversation: Conversation
        let created: Bool?
    }

    private struct SentPayload: Decodable, Sendable {
        let message: ChatMessage
        let conversation: Conversation?
    }

    private struct UsersPayload: Decodable, Sendable {
        let users: [ChatUser]
    }

    private struct MessageEvent: Decodable, Sendable {
        let conversationID: String
        let message: ChatMessage

        enum CodingKeys: String, CodingKey {
            case conversationID = "conversation_id"
            case message
        }
    }

    private struct ReactionEvent: Decodable, Sendable {
        let conversationID: String
        let messageID: String
        let reactions: [ReactionRecord]

        enum CodingKeys: String, CodingKey {
            case conversationID = "conversation_id"
            case messageID = "message_id"
            case reactions
        }
    }

    private struct TypingEvent: Decodable, Sendable {
        let conversationID: String
        let userID: String
        let typing: Bool
        let holdSeconds: Int?

        enum CodingKeys: String, CodingKey {
            case conversationID = "conversation_id"
            case userID = "user_id"
            case typing
            case holdSeconds = "hold_seconds"
        }
    }

    private struct ConversationEvent: Decodable, Sendable {
        let conversationID: String

        enum CodingKeys: String, CodingKey {
            case conversationID = "conversation_id"
        }
    }

    private struct OutgoingMessage: Encodable, Sendable {
        let text: String
        let media: [ChatMedia]
        let clientID: String

        enum CodingKeys: String, CodingKey {
            case text
            case media
            case clientID = "client_id"
        }
    }

    private struct NewConversation: Encodable, Sendable {
        let memberIDs: [String]
        let memberExternalIDs: [String]
        let name: String?

        enum CodingKeys: String, CodingKey {
            case memberIDs = "member_ids"
            case memberExternalIDs = "member_external_ids"
            case name
        }
    }

    private static let conversationsFile = "conversations.json"
    private static let meFile = "me.json"
    private static let threadWindow = 300

    public let baseURL: URL
    public private(set) var me: ChatUser?
    public private(set) var conversations: [Conversation]
    public private(set) var threads: [String: [ChatMessage]] = [:]
    public private(set) var typing: [String: Set<String>] = [:]
    public private(set) var loadingThreads: Set<String> = []
    public private(set) var hasLoadedOnce: Bool
    public private(set) var isConnected = false
    public var activeConversationID: String?
    public var isForeground = true
    public var managesBadge = true

    @ObservationIgnored private let api: ChatAPI
    @ObservationIgnored private let tokens: TokenStore
    @ObservationIgnored private let cache: FileCache
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var typingExpiry: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var outgoingTyping: Task<Void, Never>?
    @ObservationIgnored private var outgoingTypingIn: String?
    @ObservationIgnored private var localMedia: [String: [ChatMedia]] = [:]
    @ObservationIgnored private var exhausted: Set<String> = []

    public init(baseURL: URL) {
        self.baseURL = baseURL
        let scope = baseURL.host() ?? "default"
        let tokens = TokenStore(service: "swift-chat:\(scope)")
        self.tokens = tokens
        cache = FileCache(scope: scope)
        let token = tokens.read()
        let cached = token == nil ? nil : cache.load([Conversation].self, named: Self.conversationsFile)
        conversations = cached ?? []
        hasLoadedOnce = cached != nil
        me = token == nil ? nil : cache.load(ChatUser.self, named: Self.meFile)
        api = ChatAPI(baseURL: baseURL, tokenProvider: { tokens.read() }, unauthorized: {})
    }

    public var isSignedIn: Bool { tokens.read() != nil }

    public var totalUnread: Int {
        conversations.reduce(0) { $0 + $1.unread }
    }

    public func conversation(_ id: String) -> Conversation? {
        conversations.first { $0.id == id }
    }

    public func messages(in id: String) -> [ChatMessage] {
        threads[id] ?? []
    }

    public func user(_ userID: String) -> ChatUser? {
        if let me, me.id == userID { return me }
        for conversation in conversations {
            if let participant = conversation.participant(userID) { return participant.user }
        }
        return nil
    }

    public func title(of conversation: Conversation) -> String {
        conversation.title(for: me?.id)
    }

    public func hasOlderMessages(in id: String) -> Bool? {
        if exhausted.contains(id) { return false }
        guard let oldest = threads[id]?.filter(\.isStored).map(\.seq).min() else { return nil }
        return oldest > 1
    }

    public func signIn(token: String) async throws {
        let payload: MePayload = try await api.get("v1/me", token: token)
        tokens.write(token)
        adopt(me: payload.user)
        start()
    }

    public func signInAnonymously(name: String? = nil) async throws {
        let payload: SignedInPayload = try await api.send("POST", "v1/users/anonymous", body: ["name": name])
        tokens.write(payload.token)
        adopt(me: payload.user)
        start()
    }

    public func signOut() {
        stop()
        tokens.clear()
        typingExpiry.values.forEach { $0.cancel() }
        typingExpiry = [:]
        me = nil
        conversations = []
        threads = [:]
        typing = [:]
        loadingThreads = []
        exhausted = []
        localMedia = [:]
        hasLoadedOnce = false
        activeConversationID = nil
        cache.erase()
        if managesBadge { Task { try? await UNUserNotificationCenter.current().setBadgeCount(0) } }
    }

    public func updateProfile(name: String? = nil, avatarURL: URL? = nil) async throws {
        struct Patch: Encodable, Sendable {
            let name: String?
            let avatarURL: URL?

            enum CodingKeys: String, CodingKey {
                case name
                case avatarURL = "avatar_url"
            }
        }
        struct Reply: Decodable, Sendable {
            let user: ChatUser
        }
        let reply: Reply = try await api.send("PATCH", "v1/me", body: Patch(name: name, avatarURL: avatarURL))
        adopt(me: reply.user)
    }

    public func start() {
        guard streamTask == nil, isSignedIn else { return }
        streamTask = Task { [weak self] in
            await self?.run()
        }
    }

    public func stop() {
        streamTask?.cancel()
        streamTask = nil
        isConnected = false
        endOutgoingTyping()
    }

    private func run() async {
        var cursor: Int?
        var backoff = 1.0
        while !Task.isCancelled {
            do {
                if cursor == nil { cursor = try await refresh() }
                guard let after = cursor else { continue }
                var saidBye = false
                for try await event in api.events(after: after) {
                    backoff = 1
                    isConnected = true
                    if let id = event.id { cursor = id }
                    if event.name == "bye" {
                        saidBye = true
                        break
                    }
                    await apply(event)
                }
                isConnected = false
                if !saidBye { try await Task.sleep(for: .milliseconds(500)) }
            } catch is CancellationError {
                isConnected = false
                return
            } catch {
                isConnected = false
                if Task.isCancelled { return }
                if let failure = error as? ChatClientError, failure.status == 401 {
                    signOut()
                    return
                }
                cursor = nil
                try? await Task.sleep(for: .seconds(backoff))
                backoff = min(backoff * 2, 15)
            }
        }
    }

    @discardableResult
    public func refresh() async throws -> Int {
        let payload: ListPayload = try await api.get("v1/conversations")
        conversations = payload.conversations
        hasLoadedOnce = true
        persistConversations()
        for conversation in payload.conversations {
            for participant in conversation.participants where participant.typing && participant.user.id != me?.id {
                showTyping(participant.user.id, in: conversation.id, holdSeconds: 8)
            }
            let known = threads[conversation.id]?.filter(\.isStored).map(\.seq).max()
            if let known, known < conversation.lastSeq {
                await catchUp(conversation.id)
            }
        }
        if let active = activeConversationID, isForeground { markRead(active) }
        updateBadge()
        return payload.eventSeq
    }

    private func apply(_ event: ServerEvent) async {
        let decoder = JSONCoding.decoder()
        switch event.name {
        case "message":
            guard let payload = try? decoder.decode(MessageEvent.self, from: event.data) else { return }
            await receive(payload.message)
        case "receipt":
            guard let receipt = try? decoder.decode(Receipt.self, from: event.data) else { return }
            adopt(receipt)
        case "reaction":
            guard let payload = try? decoder.decode(ReactionEvent.self, from: event.data) else { return }
            setReactions(payload.reactions, onServerID: payload.messageID, in: payload.conversationID)
        case "typing":
            guard let payload = try? decoder.decode(TypingEvent.self, from: event.data), payload.userID != me?.id else { return }
            if payload.typing {
                showTyping(payload.userID, in: payload.conversationID, holdSeconds: payload.holdSeconds ?? 8)
            } else {
                clearTyping(payload.userID, in: payload.conversationID)
            }
        case "conversation_updated":
            guard let payload = try? decoder.decode(ConversationEvent.self, from: event.data) else { return }
            if let fetched: ConversationPayload = try? await api.get("v1/conversations/\(payload.conversationID)") {
                adopt(fetched.conversation)
            }
        case "conversation_removed":
            guard let payload = try? decoder.decode(ConversationEvent.self, from: event.data) else { return }
            forget(payload.conversationID)
        default:
            break
        }
    }

    private func receive(_ message: ChatMessage) async {
        let id = message.conversationID
        guard conversations.contains(where: { $0.id == id }) else {
            _ = try? await refresh()
            return
        }
        let mine = message.senderID == me?.id
        if let sender = message.senderID, !mine, typing[id]?.contains(sender) == true {
            clearTyping(sender, in: id)
            try? await Task.sleep(for: .milliseconds(80))
        }
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }

        let isNew = message.seq > conversations[index].lastSeq
        if let thread = threads[id] {
            let newestStored = thread.filter(\.isStored).map(\.seq).max() ?? 0
            if message.seq > newestStored + 1, newestStored > 0 || message.seq > 1 {
                await catchUp(id)
            } else {
                merge([message], into: id)
            }
        }

        guard let current = conversations.firstIndex(where: { $0.id == id }) else { return }
        if isNew {
            conversations[current].lastSeq = message.seq
            conversations[current].lastMessage = message
            conversations[current].lastMessageAt = message.createdAt
            if mine {
                conversations[current].me.readSeq = message.seq
                conversations[current].me.deliveredSeq = message.seq
                conversations[current].unread = 0
            } else if activeConversationID == id, isForeground {
                markRead(id)
            } else {
                conversations[current].unread += 1
            }
        }
        sortConversations()
        persistConversations()
        updateBadge()
    }

    private func adopt(_ receipt: Receipt) {
        guard let index = conversations.firstIndex(where: { $0.id == receipt.conversationID }) else { return }
        if receipt.userID == me?.id {
            conversations[index].me.readSeq = max(conversations[index].me.readSeq, receipt.readSeq)
            conversations[index].me.deliveredSeq = max(conversations[index].me.deliveredSeq, receipt.deliveredSeq)
            if conversations[index].me.readSeq >= conversations[index].lastSeq { conversations[index].unread = 0 }
            updateBadge()
        }
        if let position = conversations[index].participants.firstIndex(where: { $0.user.id == receipt.userID }) {
            conversations[index].participants[position].readSeq = max(conversations[index].participants[position].readSeq, receipt.readSeq)
            conversations[index].participants[position].deliveredSeq = max(conversations[index].participants[position].deliveredSeq, receipt.deliveredSeq)
        }
        persistConversations()
    }

    private func adopt(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.append(conversation)
        }
        sortConversations()
        persistConversations()
        updateBadge()
    }

    private func adopt(me user: ChatUser) {
        me = user
        cache.save(user, named: Self.meFile)
    }

    private func sortConversations() {
        conversations.sort { $0.lastMessageAt > $1.lastMessageAt }
    }

    private func merge(_ incoming: [ChatMessage], into id: String) {
        var thread = threads[id] ?? []
        for message in incoming {
            let match = thread.firstIndex { existing in
                if let serverID = existing.serverID, serverID == message.serverID { return true }
                if let clientID = existing.clientID, clientID == message.clientID { return true }
                return false
            }
            if let match {
                thread[match] = message
            } else {
                thread.append(message)
            }
        }
        thread.sort { left, right in
            if left.seq != right.seq { return left.seq < right.seq }
            if left.isStored != right.isStored { return left.isStored }
            return left.createdAt < right.createdAt
        }
        threads[id] = thread
        persistThread(id)
    }

    public func open(_ id: String) async {
        activeConversationID = id
        if threads[id] == nil {
            var cached = cache.load([ChatMessage].self, named: Self.threadFile(id)) ?? []
            for index in cached.indices where cached[index].delivery == .sending {
                cached[index].delivery = .failed
            }
            threads[id] = cached
        }
        markRead(id)
        await catchUp(id)
        markRead(id)
    }

    public func close(_ id: String) {
        if activeConversationID == id { activeConversationID = nil }
        if outgoingTypingIn == id { endOutgoingTyping() }
    }

    private func catchUp(_ id: String) async {
        guard !loadingThreads.contains(id) else { return }
        loadingThreads.insert(id)
        defer { loadingThreads.remove(id) }

        let known = threads[id]?.filter(\.isStored).map(\.seq).max() ?? 0
        let path = "v1/conversations/\(id)/messages"
        do {
            let query = known > 0
                ? [URLQueryItem(name: "after_seq", value: String(known)), URLQueryItem(name: "limit", value: "200")]
                : [URLQueryItem(name: "limit", value: "60")]
            var page: PagePayload = try await api.get(path, query: query)
            if known > 0, page.hasMore {
                page = try await api.get(path, query: [URLQueryItem(name: "limit", value: "60")])
                let unsent = threads[id]?.filter { !$0.isStored } ?? []
                threads[id] = unsent
                exhausted.remove(id)
            } else if known == 0, !page.hasMore {
                exhausted.insert(id)
            }
            merge(page.messages, into: id)
            if let conversation = page.conversation { adopt(conversation) }
        } catch {
            return
        }
    }

    public func loadOlder(in id: String) async -> Bool {
        guard !exhausted.contains(id),
              let oldest = threads[id]?.filter(\.isStored).map(\.seq).min(),
              oldest > 1
        else { return false }
        let query = [URLQueryItem(name: "before_seq", value: String(oldest)), URLQueryItem(name: "limit", value: "50")]
        guard let page: PagePayload = try? await api.get("v1/conversations/\(id)/messages", query: query) else { return false }
        merge(page.messages, into: id)
        if !page.hasMore { exhausted.insert(id) }
        return page.hasMore
    }

    public func send(text: String?, media: [MessageMedia] = [], in id: String) async {
        let trimmed = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !media.isEmpty, let me else { return }

        let clientID = UUID().uuidString.lowercased()
        var local: [ChatMedia] = []
        for (index, item) in media.enumerated() {
            switch item {
            case .image(let url, _, _, _):
                let prepared = await Task.detached { PhotoPrep.prepare(contentsOf: url) }.value
                guard let prepared else { continue }
                let file = cache.attachments.appending(path: "\(clientID)-\(index).jpg")
                guard (try? prepared.data.write(to: file, options: .atomic)) != nil else { continue }
                local.append(ChatMedia(url: file, kind: .image, width: prepared.width, height: prepared.height))
            case .file(let url, let name, let size, _):
                let file = cache.attachments.appending(path: "\(clientID)-\(index)-\(name)")
                guard (try? FileManager.default.copyItem(at: url, to: file)) != nil else { continue }
                local.append(ChatMedia(url: file, kind: .file, name: name, size: size.map(Int.init)))
            case .video(let url, _, _):
                let file = cache.attachments.appending(path: "\(clientID)-\(index).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)")
                guard (try? FileManager.default.copyItem(at: url, to: file)) != nil else { continue }
                local.append(ChatMedia(url: file, kind: .file, name: url.lastPathComponent))
            @unknown default:
                continue
            }
        }
        guard !trimmed.isEmpty || !local.isEmpty else { return }

        endOutgoingTyping()
        let newest = max(conversation(id)?.lastSeq ?? 0, threads[id]?.map(\.seq).max() ?? 0)
        let pending = ChatMessage(
            serverID: nil,
            clientID: clientID,
            conversationID: id,
            seq: newest + 1,
            senderID: me.id,
            text: trimmed,
            media: local,
            createdAt: .now,
            reactions: [],
            delivery: .sending
        )
        localMedia[clientID] = local
        threads[id, default: []].append(pending)
        persistThread(id)
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            conversations[index].lastMessage = pending
            conversations[index].lastMessageAt = pending.createdAt
            sortConversations()
        }
        await deliver(clientID: clientID, in: id)
    }

    public func retry(_ messageID: String, in id: String) async {
        guard let message = threads[id]?.first(where: { $0.id == messageID }),
              message.delivery == .failed,
              let clientID = message.clientID
        else { return }
        await deliver(clientID: clientID, in: id)
    }

    private func deliver(clientID: String, in id: String) async {
        guard let pending = threads[id]?.first(where: { $0.clientID == clientID && !$0.isStored }) else { return }
        setDelivery(.sending, clientID: clientID, in: id)
        do {
            var remote: [ChatMedia] = []
            for item in pending.media {
                guard item.url.isFileURL else {
                    remote.append(item)
                    continue
                }
                let file = item.url
                let data = try await Task.detached { try Data(contentsOf: file) }.value
                let contentType = item.kind == .image ? "image/jpeg" : PhotoPrep.contentType(for: file)
                let url = try await api.upload(data, contentType: contentType, filename: item.name)
                remote.append(ChatMedia(url: url, kind: item.kind, name: item.name, size: item.size ?? data.count, width: item.width, height: item.height))
            }
            let sent: SentPayload = try await api.send(
                "POST",
                "v1/conversations/\(id)/messages",
                body: OutgoingMessage(text: pending.text, media: remote, clientID: clientID)
            )
            merge([sent.message], into: id)
            if let conversation = sent.conversation {
                adopt(conversation)
            } else if let index = conversations.firstIndex(where: { $0.id == id }), sent.message.seq >= conversations[index].lastSeq {
                conversations[index].lastSeq = sent.message.seq
                conversations[index].lastMessage = sent.message
                conversations[index].lastMessageAt = sent.message.createdAt
                conversations[index].me.readSeq = sent.message.seq
                conversations[index].unread = 0
                sortConversations()
                persistConversations()
            }
        } catch {
            setDelivery(.failed, clientID: clientID, in: id)
        }
    }

    private func setDelivery(_ delivery: ChatMessage.Delivery, clientID: String, in id: String) {
        guard let index = threads[id]?.firstIndex(where: { $0.clientID == clientID && !$0.isStored }) else { return }
        threads[id]?[index].delivery = delivery
        persistThread(id)
    }

    public func displayMedia(for message: ChatMessage) -> [ChatMedia] {
        if let clientID = message.clientID, let local = localMedia[clientID] { return local }
        return message.media
    }

    public func toggleReaction(_ emoji: String, on messageID: String, part: ReactionRecord.Part = .message, in id: String) {
        guard let me,
              let index = threads[id]?.firstIndex(where: { $0.id == messageID }),
              let serverID = threads[id]?[index].serverID
        else { return }
        let mine = threads[id]?[index].reactions.first { $0.userID == me.id && $0.part == part }
        let next: String? = mine?.emoji == emoji ? nil : emoji
        threads[id]?[index].reactions.removeAll { $0.userID == me.id && $0.part == part }
        if let next {
            threads[id]?[index].reactions.append(ReactionRecord(userID: me.id, emoji: next, part: part))
        }
        persistThread(id)
        struct Body: Encodable, Sendable {
            let emoji: String?
            let part: String
        }
        Task {
            let _: Acknowledged? = try? await api.send("PUT", "v1/conversations/\(id)/messages/\(serverID)/reaction", body: Body(emoji: next, part: part.rawValue))
        }
    }

    private func setReactions(_ reactions: [ReactionRecord], onServerID serverID: String, in id: String) {
        guard let index = threads[id]?.firstIndex(where: { $0.serverID == serverID }) else { return }
        threads[id]?[index].reactions = reactions
        persistThread(id)
    }

    public func startConversation(with userIDs: [String] = [], externalIDs: [String] = [], name: String? = nil) async throws -> Conversation {
        let payload: ConversationPayload = try await api.send("POST", "v1/conversations", body: NewConversation(memberIDs: userIDs, memberExternalIDs: externalIDs, name: name))
        adopt(payload.conversation)
        return payload.conversation
    }

    public func addMembers(_ userIDs: [String], to id: String) async throws {
        let payload: ConversationPayload = try await api.send("POST", "v1/conversations/\(id)/members", body: NewConversation(memberIDs: userIDs, memberExternalIDs: [], name: nil))
        adopt(payload.conversation)
    }

    public func rename(_ id: String, to name: String?) async throws {
        let payload: ConversationPayload = try await api.send("PATCH", "v1/conversations/\(id)", body: ["name": name])
        adopt(payload.conversation)
    }

    public func setMuted(_ muted: Bool, in id: String) async throws {
        let payload: ConversationPayload = try await api.send("PATCH", "v1/conversations/\(id)", body: ["muted": muted])
        adopt(payload.conversation)
    }

    public func leave(_ id: String) async {
        forget(id)
        let _: Acknowledged? = try? await api.send("DELETE", "v1/conversations/\(id)")
    }

    public func searchUsers(_ query: String) async throws -> [ChatUser] {
        let payload: UsersPayload = try await api.get("v1/users", query: [URLQueryItem(name: "q", value: query)])
        return payload.users.filter { $0.id != me?.id }
    }

    public func registerDevice(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        Task {
            let _: Acknowledged? = try? await api.send("POST", "v1/devices", body: ["token": hex, "environment": environment])
        }
    }

    public func unregisterDevice(token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        Task {
            let _: Acknowledged? = try? await api.send("DELETE", "v1/devices/\(hex)")
        }
    }

    private func forget(_ id: String) {
        conversations.removeAll { $0.id == id }
        threads[id] = nil
        exhausted.remove(id)
        typing[id] = nil
        cache.remove(named: Self.threadFile(id))
        persistConversations()
        updateBadge()
    }

    public func markRead(_ id: String) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        let conversation = conversations[index]
        guard conversation.unread > 0 || conversation.me.readSeq < conversation.lastSeq else { return }
        conversations[index].unread = 0
        conversations[index].me.readSeq = conversation.lastSeq
        persistConversations()
        updateBadge()
        let seq = conversation.lastSeq
        Task {
            let _: Acknowledged? = try? await api.send("POST", "v1/conversations/\(id)/read", body: ["seq": seq])
        }
    }

    public func setTyping(_ isTyping: Bool, in id: String) {
        if isTyping {
            guard outgoingTypingIn != id else { return }
            endOutgoingTyping()
            outgoingTypingIn = id
            outgoingTyping = Task {
                while !Task.isCancelled {
                    let _: Acknowledged? = try? await api.send("POST", "v1/conversations/\(id)/typing", body: ["typing": true])
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        } else if outgoingTypingIn == id {
            endOutgoingTyping()
        }
    }

    private func endOutgoingTyping() {
        guard let id = outgoingTypingIn else { return }
        outgoingTyping?.cancel()
        outgoingTyping = nil
        outgoingTypingIn = nil
        Task {
            let _: Acknowledged? = try? await api.send("POST", "v1/conversations/\(id)/typing", body: ["typing": false])
        }
    }

    private func showTyping(_ userID: String, in id: String, holdSeconds: Int) {
        typing[id, default: []].insert(userID)
        let key = "\(id):\(userID)"
        typingExpiry[key]?.cancel()
        typingExpiry[key] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(holdSeconds))
            guard !Task.isCancelled else { return }
            self?.clearTyping(userID, in: id)
        }
    }

    private func clearTyping(_ userID: String, in id: String) {
        let key = "\(id):\(userID)"
        typingExpiry[key]?.cancel()
        typingExpiry[key] = nil
        typing[id]?.remove(userID)
        if typing[id]?.isEmpty == true { typing[id] = nil }
    }

    private func persistConversations() {
        cache.save(conversations, named: Self.conversationsFile)
    }

    private func persistThread(_ id: String) {
        guard let thread = threads[id] else { return }
        cache.save(Array(thread.suffix(Self.threadWindow)), named: Self.threadFile(id))
    }

    private func updateBadge() {
        guard managesBadge else { return }
        let count = totalUnread
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
    }

    private static func threadFile(_ id: String) -> String {
        "thread-\(id).json"
    }
}
