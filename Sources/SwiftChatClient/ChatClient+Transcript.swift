import Foundation
import SwiftChat

extension ChatClient {
    public func role(of message: ChatMessage) -> ChatRole {
        guard let senderID = message.senderID else { return .system }
        if senderID == me?.id { return .me }
        return .user(id: senderID, displayName: user(senderID)?.displayName)
    }

    public func user(for role: ChatRole) -> ChatUser? {
        switch role {
        case .me: return me
        case .user(let id, _): return user(id)
        default: return nil
        }
    }

    public func lastOutgoingID(in conversationID: String) -> String? {
        threads[conversationID]?.last { $0.senderID == me?.id && $0.isStored }?.id
    }

    public func status(of message: ChatMessage, lastOutgoingID: String?, in conversation: Conversation?) -> ChatDeliveryStatus? {
        guard let me, message.senderID == me.id else { return nil }
        if message.delivery == .sending { return nil }
        if message.delivery == .failed { return .failed }
        guard message.id == lastOutgoingID, let conversation else { return nil }
        let others = conversation.others(than: me.id)
        guard !others.isEmpty else { return .sent }
        if others.allSatisfy({ $0.readSeq >= message.seq }) { return .read }
        if others.allSatisfy({ $0.deliveredSeq >= message.seq }) { return .delivered }
        return .sent
    }

    public func reactions(of message: ChatMessage, part: ReactionRecord.Part = .message) -> [ChatReaction] {
        var order: [String] = []
        var people: [String: [ChatReaction.Person]] = [:]
        var mine: Set<String> = []
        for record in message.reactions where record.part == part {
            if people[record.emoji] == nil { order.append(record.emoji) }
            let person = user(record.userID)
            people[record.emoji, default: []].append(ChatReaction.Person(id: record.userID, name: person?.displayName ?? "Someone", photoURL: person?.avatarURL))
            if record.userID == me?.id { mine.insert(record.emoji) }
        }
        return order.map { ChatReaction(emoji: $0, people: people[$0] ?? [], isMine: mine.contains($0)) }
    }

    public func typingRoles(in conversationID: String) -> [ChatRole] {
        (typing[conversationID] ?? []).sorted().map { ChatRole.user(id: $0, displayName: user($0)?.displayName) }
    }

    public func transcriptRow(for message: ChatMessage, lastOutgoingID: String?, in conversation: Conversation?) -> Message {
        var row = Message(message.text, role: role(of: message), timestamp: message.createdAt)
            .messageStatus(status(of: message, lastOutgoingID: lastOutgoingID, in: conversation))
            .messageReactions(reactions(of: message))
        let media = displayMedia(for: message)
        if !media.isEmpty {
            row = row.messageMedia(media.map(\.messageMedia))
            row = row.messageMediaReactions(reactions(of: message, part: .media))
        }
        return row
    }

    public func contextMenuItems(for messageID: String, in conversationID: String) -> [ChatContextMenuItem] {
        guard let message = threads[conversationID]?.first(where: { $0.id == messageID }) else { return [] }
        var items: [ChatContextMenuItem] = []
        if message.isStored {
            if displayMedia(for: message).isEmpty || message.text.isEmpty {
                items.append(.tapbacks(reactions(of: message)) { [weak self] emoji in
                    self?.toggleReaction(emoji, on: messageID, in: conversationID)
                })
            } else {
                items.append(.tapbacks(reactions(of: message), media: reactions(of: message, part: .media)) { [weak self] emoji, part in
                    self?.toggleReaction(emoji, on: messageID, part: part == .media ? .media : .message, in: conversationID)
                })
            }
        }
        if message.delivery == .failed {
            if !items.isEmpty { items.append(.separator) }
            items.append(ChatContextMenuItem("Try Again", systemImage: "arrow.clockwise") { [weak self] in
                Task { await self?.retry(messageID, in: conversationID) }
            })
        }
        return items
    }
}
