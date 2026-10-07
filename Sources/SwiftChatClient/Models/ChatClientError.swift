import Foundation

public struct ChatClientError: LocalizedError, Sendable {
    public let status: Int
    public let code: String?
    public let errorDescription: String?

    public init(status: Int, code: String?, message: String?) {
        self.status = status
        self.code = code
        self.errorDescription = message
    }

    public static let notSignedIn = ChatClientError(status: 401, code: "not_signed_in", message: "Sign in before using the chat client.")
}
