import Foundation

public struct Participant: Codable, Hashable, Identifiable, Sendable {
    public var user: ChatUser
    public var readSeq: Int
    public var deliveredSeq: Int
    public var typing: Bool
    public var joinedAt: Date

    public var id: String { user.id }

    enum CodingKeys: String, CodingKey {
        case user
        case readSeq = "read_seq"
        case deliveredSeq = "delivered_seq"
        case typing
        case joinedAt = "joined_at"
    }
}
