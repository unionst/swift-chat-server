import Foundation

struct ServerEvent: Sendable {
    var name: String
    var id: Int?
    var data: Data
}
