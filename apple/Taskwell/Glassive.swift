import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Glassive design tokens, matching web/src/glassive.css. Each color has a light and a dark value.
enum Glassive {
    /// The app mark keeps its own blue; it is not the interface accent.
    static let mark = Color(hex: "2563eb")

    static let accent = Color(light: "1e8dff", dark: "1f95ff")        // interactive-accent (color-accent-1)
    static let textAccent = Color(light: "0088ff", dark: "0090ff")    // text-accent (accent-blue)
    static let red = Color(light: "e93147", dark: "fb464c")           // text-error
    static let orange = Color(light: "ec7500", dark: "e9973f")        // text-warning
    static let green = Color(light: "08b94e", dark: "44cf6e")         // text-success

    static let backgroundPrimary = Color(light: "ffffff", dark: "282828")
    static let backgroundSecondary = Color(light: "f6f6f6", dark: "1c1c1c")
    static let checkRing = Color(light: "707070", dark: "999999")     // color-base-60
    static let border = Color(light: "000000", dark: "ffffff").opacity(0.08)  // background-modifier-border-subtle

    static let menuRadius: CGFloat = 20
    static let cardRadius: CGFloat = 24

    /// Checkbox color for a task priority: urgent red, high orange, medium accent.
    static func priority(_ value: Int) -> Color {
        switch value {
        case 1: red
        case 2: orange
        case 3: accent
        default: checkRing
        }
    }
}

extension Color {
    init(light: String, dark: String) {
        #if os(iOS)
        self.init(uiColor: UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
        #else
        self.init(nsColor: NSColor(name: nil) { appearance in
            NSColor(Color(hex: appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light))
        })
        #endif
    }
}
