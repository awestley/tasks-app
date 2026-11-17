import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Clean design tokens, matching web/src/clean.css. Each color has a light and a dark value.
enum Clean {

    static let canvas = Color(light: "f1f1f2", dark: "18181a")         // bg-canvas
    static let surface = Color(light: "ffffff", dark: "0a0a0b")        // bg-surface
    static let subtle = Color(light: "f6f6f7", dark: "161618")         // bg-subtle
    static let muted = Color(light: "ececee", dark: "26262a")          // bg-muted
    /// The strongest fill: primary buttons and checked boxes. Text on it is textInverse.
    static let inverse = Color(light: "0f0f10", dark: "fafafa")        // bg-inverse
    static let textInverse = Color(light: "ffffff", dark: "0a0a0b")    // text-inverse

    static let border = Color(light: "e6e6e9", dark: "26262b")         // border
    static let borderStrong = Color(light: "d4d4d8", dark: "3a3a40")   // border-strong
    static let borderControl = Color(light: "85858e", dark: "76767f")  // border-control

    static let text = Color(light: "0f0f10", dark: "fafafa")           // text
    static let textSecondary = Color(light: "52525b", dark: "b4b4bd")  // text-secondary
    static let textMuted = Color(light: "696972", dark: "9a9aa3")      // text-muted

    /// The one brand hue, for links, progress and promotional actions.
    static let accent = Color(light: "2563eb", dark: "6b9bff")         // accent
    static let success = Color(light: "157a3b", dark: "4ade80")        // success: done, live, on
    static let warning = Color(light: "c2410c", dark: "fb923c")        // warning: in progress, new
    static let danger = Color(light: "d32222", dark: "f87171")         // danger: declined, failed
    static let sky = Color(light: "0369a1", dark: "7dd3fc")            // sky: keyboard focus
    static let skySoft = Color(light: "e0f2fe", dark: "0c2a3d")        // sky-soft

    static let radiusSM: CGFloat = 6
    static let radiusMD: CGFloat = 8                                    // buttons, inputs, nav items
    static let radiusLG: CGFloat = 12                                   // cards, rows
    static let radiusXL: CGFloat = 16                                   // modals and large panels

    /// Checkbox color for a task priority: urgent danger, high warning, medium accent.
    static func priority(_ value: Int) -> Color {
        switch value {
        case 1: danger
        case 2: warning
        case 3: accent
        default: borderControl
        }
    }
}

/// The primary action: the inverse fill with medium-weight text, radius-md.
struct CleanPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(Clean.textInverse)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(Clean.inverse, in: RoundedRectangle(cornerRadius: Clean.radiusMD, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.88 : 1) : 0.5)
            .contentShape(RoundedRectangle(cornerRadius: Clean.radiusMD, style: .continuous))
    }
}

/// The secondary action: bg-surface with a border-strong hairline, radius-md.
struct CleanSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: Clean.radiusMD, style: .continuous)
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(isEnabled ? Clean.text : Clean.textMuted)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(configuration.isPressed || !isEnabled ? Clean.subtle : Clean.surface, in: shape)
            .overlay(shape.stroke(Clean.borderStrong))
            .contentShape(shape)
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
