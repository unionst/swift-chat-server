import Foundation
import SwiftChat

public struct ChatMedia: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case image
        case file
    }

    public var url: URL
    public var kind: Kind
    public var name: String?
    public var size: Int?
    public var width: Int?
    public var height: Int?

    public init(url: URL, kind: Kind = .image, name: String? = nil, size: Int? = nil, width: Int? = nil, height: Int? = nil) {
        self.url = url
        self.kind = kind
        self.name = name
        self.size = size
        self.width = width
        self.height = height
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        url = try container.decode(URL.self, forKey: .url)
        kind = try container.decodeIfPresent(Kind.self, forKey: .kind) ?? .image
        name = try container.decodeIfPresent(String.self, forKey: .name)
        size = try container.decodeIfPresent(Int.self, forKey: .size)
        width = try container.decodeIfPresent(Int.self, forKey: .width)
        height = try container.decodeIfPresent(Int.self, forKey: .height)
    }

    public var messageMedia: MessageMedia {
        switch kind {
        case .image:
            return .image(url: url, width: width, height: height)
        case .file:
            return .file(url: url, name: name ?? url.lastPathComponent, size: size.map(Int64.init))
        }
    }
}
