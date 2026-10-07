import SwiftChatClient
import SwiftUI

struct RootView: View {
    let client: ChatClient
    @State private var signedIn = false

    var body: some View {
        Group {
            if signedIn {
                InboxView(client: client)
            } else {
                SignInView(client: client) { signedIn = true }
            }
        }
        .task {
            if let token = DemoLaunch.token {
                try? await client.signIn(token: token)
            } else if client.isSignedIn {
                client.start()
            }
            signedIn = client.isSignedIn
        }
    }
}
