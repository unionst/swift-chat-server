import SwiftChatClient
import SwiftUI

struct SignInView: View {
    let client: ChatClient
    let onSignedIn: () -> Void
    @State private var name = ""
    @State private var failure: String?

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right.fill")
                .font(.system(size: 56))
                .foregroundStyle(.blue)
            Text("Swift Chat")
                .font(.largeTitle.bold())
            TextField("Your name", text: $name)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.words)
                .padding(.horizontal, 40)
            Button("Start chatting") {
                Task {
                    do {
                        try await client.signInAnonymously(name: name.isEmpty ? nil : name)
                        onSignedIn()
                    } catch {
                        failure = error.localizedDescription
                    }
                }
            }
            .buttonStyle(.glassProminent)
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            Spacer()
        }
        .padding()
    }
}
