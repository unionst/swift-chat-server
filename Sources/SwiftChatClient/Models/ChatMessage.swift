import Foundation

public struct ChatMessage: Codable, Hashable, Identifiable, Sendable {
    public enum Delivery: String, Codable, Hashable, Sendable {
        case sending
        case failed
    }

    public var serverID: String?
    public var clientID: String?
    public var conversationID: String
    public var seq: Int
    public var senderID: String?
    public var text: String
    public var media: [ChatMedia]
    public var createdAt: Date
    public var reactions: [ReactionRecord]
    public var data: [String: JSONValue]
    public var delivery: Delivery?

    public var id: String { clientID ?? serverID ?? "" }
    public var isStored: Bool { serverID != nil }
    public var isSystem: Bool { senderID == nil }

    public var preview: String {
        if !text.isEmpty { return text }
        if let preview = data["preview"]?.stringValue, !preview.isEmpty { return preview }
        let images = media.filter { $0.kind == .image }.count
        let files = media.count - images
        if images > 0, files == 0 { return images > 1 ? "\(images) Photos" : "Photo" }
        if files > 0, images == 0 { return files > 1 ? "\(files) Files" : (media.first?.name ?? "File") }
        return "Attachment"
    }

    enum CodingKeys: String, CodingKey {
        case serverID = "id"
        case clientID = "client_id"
        case conversationID = "conversation_id"
        case seq
        case senderID = "sender_id"
        case text
        case media
        case createdAt = "created_at"
        case reactions
        case data
        case delivery
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serverID = try container.decodeIfPresent(String.self, forKey: .serverID)
        clientID = try container.decodeIfPresent(String.self, forKey: .clientID)
        conversationID = try container.decode(String.self, forKey: .conversationID)
        seq = try container.decode(Int.self, forKey: .seq)
        senderID = try container.decodeIfPresent(String.self, forKey: .senderID)
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        media = try container.decodeIfPresent([ChatMedia].self, forKey: .media) ?? []
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        reactions = try container.decodeIfPresent([ReactionRecord].self, forKey: .reactions) ?? []
        data = try container.decodeIfPresent([String: JSONValue].self, forKey: .data) ?? [:]
        delivery = try container.decodeIfPresent(Delivery.self, forKey: .delivery)
    }

    public init(serverID: String?, clientID: String?, conversationID: String, seq: Int, senderID: String?, text: String, media: [ChatMedia], createdAt: Date, reactions: [ReactionRecord], data: [String: JSONValue] = [:], delivery: Delivery? = nil) {
        self.serverID = serverID
        self.clientID = clientID
        self.conversationID = conversationID
        self.seq = seq
        self.senderID = senderID
        self.text = text
        self.media = media
        self.createdAt = createdAt
        self.reactions = reactions
        self.data = data
        self.delivery = delivery
    }
}
