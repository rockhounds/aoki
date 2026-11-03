import Foundation

enum T3SharedContainer {
    #if DEBUG
    static let appGroupID = "group.io.github.rockhounds.aoki.native.dev"
    static let urlScheme = "aoki-native-dev"
    #else
    static let appGroupID = "group.io.github.rockhounds.aoki.native"
    static let urlScheme = "aoki-native"
    #endif

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
