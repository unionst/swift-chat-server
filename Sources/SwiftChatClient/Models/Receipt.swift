import Foundation

public struct Receipt: Codable, Hashable, Sendable {
    public var conversationID: String
    public var userID: String
    public var deliveredSeq: Int
    public var readSeq: Int

    enum CodingKeys: String, CodingKey {
        case conversationID = "conversation_id"
        case userID = "user_id"
        case deliveredSeq = "delivered_seq"
        case readSeq = "read_seq"
    }
}
