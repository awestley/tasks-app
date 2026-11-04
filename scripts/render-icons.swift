// Regenerate the simple vector app mark in blue for web and Apple icon catalogs.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func writeIcon(_ size: Int, _ path: String) throws {
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    context.setFillColor(CGColor(red: 0.145, green: 0.388, blue: 0.922, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    context.setStrokeColor(CGColor(gray: 1, alpha: 1))
    context.setLineWidth(86); context.setLineCap(.round); context.setLineJoin(.round)
    context.move(to: CGPoint(x: 260, y: 500)); context.addLine(to: CGPoint(x: 430, y: 330)); context.addLine(to: CGPoint(x: 770, y: 700)); context.strokePath()
    let url = URL(fileURLWithPath: path)
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "Icons", code: 1) }
}
let folder = "apple/Taskwell/Assets.xcassets/AppIcon.appiconset/"
let data = try Data(contentsOf: URL(fileURLWithPath: folder + "Contents.json"))
let contents = try JSONSerialization.jsonObject(with: data) as! [String: Any]
for item in contents["images"] as! [[String: String]] {
    guard let filename = item["filename"], let dimensions = item["size"] else { continue }
    let size = Double(dimensions.components(separatedBy: "x")[0])!
    let scale = Double((item["scale"] ?? "1x").replacingOccurrences(of: "x", with: ""))!
    try writeIcon(Int(size * scale), folder + filename)
}
try writeIcon(192, "web/public/icon-192.png")
try writeIcon(512, "web/public/icon-512.png")
