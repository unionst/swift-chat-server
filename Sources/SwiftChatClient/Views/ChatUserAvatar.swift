import SwiftChat
import SwiftUI

public struct ChatUserAvatar: View {
    let user: ChatUser?
    let size: Double

    public init(user: ChatUser?, size: Double = 32) {
        self.user = user
        self.size = size
    }

    public var body: some View {
        if let url = user?.avatarURL {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    ChatAvatar(userName: user?.displayName ?? "?", size: size)
                }
            }
            .frame(width: size, height: size)
            .clipShape(.circle)
        } else {
            ChatAvatar(userName: user?.displayName ?? "?", size: size)
        }
    }
}
