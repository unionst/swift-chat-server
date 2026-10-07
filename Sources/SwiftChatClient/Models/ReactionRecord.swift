import Foundation

public struct ReactionRecord: Codable, Hashable, Sendable {
    public enum Part: String, Codable, Hashable, Sendable {
        case message
        case media
    }

    public var userID: String
    public var emoji: String
    public var part: Part

    public init(userID: String, emoji: String, part: Part = .message) {
        self.userID = userID
        self.emoji = emoji
        self.part = part
    }

    enum CodingKeys: String, CodingKey {
        case userID = "user_id"
        case emoji
        case part
    }
}
