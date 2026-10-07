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
    public var delivery: Delivery?

    public var id: String { clientID ?? serverID ?? "" }
    public var isStored: Bool { serverID != nil }
    public var isSystem: Bool { senderID == nil }

    public var preview: String {
        if !text.isEmpty { return text }
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
        case delivery
    }
}
