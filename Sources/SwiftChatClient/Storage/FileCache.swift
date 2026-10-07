import Foundation

struct FileCache: Sendable {
    let directory: URL

    init(scope: String) {
        let base = URL.applicationSupportDirectory.appending(path: "SwiftChatClient", directoryHint: .isDirectory).appending(path: scope, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        directory = base
    }

    var attachments: URL {
        let folder = directory.appending(path: "attachments", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    func load<T: Decodable>(_ type: T.Type, named name: String) -> T? {
        guard let data = try? Data(contentsOf: directory.appending(path: name)) else { return nil }
        return try? JSONCoding.decoder().decode(type, from: data)
    }

    func save<T: Encodable>(_ value: T, named name: String) {
        guard let data = try? JSONCoding.encoder().encode(value) else { return }
        try? data.write(to: directory.appending(path: name), options: .atomic)
    }

    func remove(named name: String) {
        try? FileManager.default.removeItem(at: directory.appending(path: name))
    }

    func erase() {
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
}
