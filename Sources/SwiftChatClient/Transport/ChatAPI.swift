import Foundation

struct Acknowledged: Decodable, Sendable {}

final class ChatAPI: Sendable {
    private struct ErrorPayload: Decodable {
        let error: String?
        let code: String?
    }

    private struct Nothing: Encodable, Sendable {}

    let baseURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let unauthorized: @Sendable () async -> Void

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.waitsForConnectivity = true
        configuration.timeoutIntervalForResource = 120
        return URLSession(configuration: configuration)
    }()

    private let streaming: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 600
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String?, unauthorized: @escaping @Sendable () async -> Void) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.unauthorized = unauthorized
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], token: String? = nil) -> URLRequest {
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = token ?? tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    func get<Reply: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], token: String? = nil) async throws -> Reply {
        try await perform(request("GET", path, query: query, token: token))
    }

    func send<Body: Encodable & Sendable, Reply: Decodable & Sendable>(_ method: String, _ path: String, body: Body, token: String? = nil) async throws -> Reply {
        var outgoing = request(method, path, token: token)
        outgoing.setValue("application/json", forHTTPHeaderField: "Content-Type")
        outgoing.httpBody = try JSONCoding.encoder().encode(body)
        return try await perform(outgoing)
    }

    func send<Reply: Decodable & Sendable>(_ method: String, _ path: String) async throws -> Reply {
        try await send(method, path, body: Nothing())
    }

    func upload(_ data: Data, contentType: String, filename: String?) async throws -> URL {
        struct Stored: Decodable, Sendable {
            let url: URL
        }
        var outgoing = request("POST", "v1/uploads")
        outgoing.setValue(contentType, forHTTPHeaderField: "Content-Type")
        if let filename { outgoing.setValue(filename, forHTTPHeaderField: "X-Filename") }
        outgoing.httpBody = data
        let stored: Stored = try await perform(outgoing)
        return stored.url
    }

    func events(after cursor: Int) -> AsyncThrowingStream<ServerEvent, Error> {
        var built = request("GET", "v1/stream", query: [URLQueryItem(name: "after", value: String(cursor))])
        built.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let outgoing = built
        let session = streaming
        return AsyncThrowingStream { continuation in
            let task = Task { [outgoing, session] in
                do {
                    let (bytes, response) = try await session.bytes(for: outgoing)
                    try await check(response, data: Data())
                    var name = "message"
                    var id: Int?
                    var data = Data()
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        if byte == 0x0A {
                            if line.isEmpty {
                                if !data.isEmpty {
                                    continuation.yield(ServerEvent(name: name, id: id, data: data))
                                }
                                name = "message"
                                id = nil
                                data = Data()
                            } else {
                                let text = String(decoding: line, as: UTF8.self)
                                if let value = Self.field("event", in: text) {
                                    name = value
                                } else if let value = Self.field("data", in: text) {
                                    data.append(contentsOf: value.utf8)
                                } else if let value = Self.field("id", in: text) {
                                    id = Int(value)
                                }
                            }
                            line.removeAll(keepingCapacity: true)
                        } else if byte != 0x0D {
                            line.append(byte)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func field(_ name: String, in line: String) -> String? {
        guard line.hasPrefix("\(name):") else { return nil }
        return String(line.dropFirst(name.count + 1)).trimmingCharacters(in: .whitespaces)
    }

    func check(_ response: URLResponse, data: Data) async throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard !(200..<300).contains(status) else { return }
        let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data)
        if status == 401 { await unauthorized() }
        throw ChatClientError(status: status, code: payload?.code, message: payload?.error ?? "Something went wrong. Try again.")
    }

    private func perform<Reply: Decodable & Sendable>(_ request: URLRequest) async throws -> Reply {
        let (data, response) = try await session.data(for: request)
        try await check(response, data: data)
        do {
            return try JSONCoding.decoder().decode(Reply.self, from: data)
        } catch {
            throw ChatClientError(status: 200, code: "unreadable", message: "The server sent something unexpected.")
        }
    }
}
