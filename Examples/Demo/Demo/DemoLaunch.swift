import Foundation

enum DemoLaunch {
    static var token: String? {
        value("DEMO_TOKEN")
    }

    static var openPeer: String? {
        value("DEMO_OPEN_PEER")
    }

    private static func value(_ key: String) -> String? {
        #if DEBUG
        let raw = ProcessInfo.processInfo.environment[key]
        return raw?.isEmpty == false ? raw : nil
        #else
        return nil
        #endif
    }
}
