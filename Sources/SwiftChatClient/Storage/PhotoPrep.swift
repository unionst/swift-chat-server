import Foundation
import ImageIO
import UniformTypeIdentifiers

enum PhotoPrep {
    struct Prepared: Sendable {
        let data: Data
        let width: Int
        let height: Int
    }

    static func prepare(contentsOf url: URL, maxDimension: Int = 1600) -> Prepared? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return prepare(data, maxDimension: maxDimension)
    }

    static func prepare(_ data: Data, maxDimension: Int = 1600) -> Prepared? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxDimension,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return Prepared(data: output as Data, width: image.width, height: image.height)
    }

    static func contentType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
