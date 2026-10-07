import Foundation

public struct ChatUser: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var externalID: String
    public var name: String?
    public var avatarURL: URL?

    public var displayName: String { name ?? "Someone" }

    public init(id: String, externalID: String, name: String? = nil, avatarURL: URL? = nil) {
        self.id = id
        self.externalID = externalID
        self.name = name
        self.avatarURL = avatarURL
    }

    enum CodingKeys: String, CodingKey {
        case id
        case externalID = "external_id"
        case name
        case avatarURL = "avatar_url"
    }
}
