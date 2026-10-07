import Foundation

public struct Conversation: Codable, Hashable, Identifiable, Sendable {
    public struct Membership: Codable, Hashable, Sendable {
        public var readSeq: Int
        public var deliveredSeq: Int
        public var muted: Bool

        enum CodingKeys: String, CodingKey {
            case readSeq = "read_seq"
            case deliveredSeq = "delivered_seq"
            case muted
        }
    }

    public let id: String
    public var name: String?
    public var photoURL: URL?
    public var direct: Bool
    public var createdAt: Date
    public var lastSeq: Int
    public var lastMessageAt: Date
    public var lastMessage: ChatMessage?
    public var unread: Int
    public var me: Membership
    public var participants: [Participant]

    public func others(than userID: String?) -> [Participant] {
        participants.filter { $0.user.id != userID }
    }

    public func title(for userID: String?) -> String {
        if let name, !name.isEmpty { return name }
        let names = others(than: userID).map(\.user.displayName)
        if names.isEmpty { return participants.first?.user.displayName ?? "Conversation" }
        if names.count <= 3 { return names.formatted(.list(type: .and, width: .short)) }
        return "\(names.prefix(2).joined(separator: ", ")) and \(names.count - 2) others"
    }

    public func participant(_ userID: String) -> Participant? {
        participants.first { $0.user.id == userID }
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case photoURL = "photo_url"
        case direct
        case createdAt = "created_at"
        case lastSeq = "last_seq"
        case lastMessageAt = "last_message_at"
        case lastMessage = "last_message"
        case unread
        case me
        case participants
    }
}
