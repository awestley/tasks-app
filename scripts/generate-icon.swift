import AppKit
import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1])
let folder = root.appendingPathComponent("apple/Taskwell/Assets.xcassets/AppIcon.appiconset")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
var images: [[String: String]] = []
func render(_ pixels: Int, mac: Bool, filename: String) throws {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let scale = CGFloat(pixels) / 1024
    let transform = AffineTransform(scale: scale)
    (transform as NSAffineTransform).concat()
    NSColor.clear.setFill(); NSRect(x:0,y:0,width:1024,height:1024).fill()
    NSColor(calibratedRed:0.459,green:0.38,blue:0.812,alpha:1).setFill()
    let margin: CGFloat = mac ? 90 : 0
    NSBezierPath(roundedRect:NSRect(x:margin,y:margin,width:1024-2*margin,height:1024-2*margin),xRadius:mac ? 190 : 0,yRadius:mac ? 190 : 0).fill()
    let check = NSBezierPath()
    check.move(to:NSPoint(x:300,y:500)); check.line(to:NSPoint(x:455,y:345)); check.line(to:NSPoint(x:755,y:680))
    check.lineWidth=88; check.lineCapStyle = .round; check.lineJoinStyle = .round
    NSColor.white.setStroke(); check.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using:.png,properties:[:])!.write(to:folder.appendingPathComponent(filename))
}
try render(1024,mac:false,filename:"ios-1024.png")
images.append(["filename":"ios-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"])
for size in [16,32,128,256,512] {
    for scale in [1,2] {
        let filename="mac-\(size)-\(scale).png"
        try render(size*scale,mac:true,filename:filename)
        images.append(["filename":filename,"idiom":"mac","size":"\(size)x\(size)","scale":"\(scale)x"])
    }
}
let contents: [String:Any] = ["images":images,"info":["author":"xcode","version":1]]
try JSONSerialization.data(withJSONObject:contents,options:[.prettyPrinted,.sortedKeys]).write(to:folder.appendingPathComponent("Contents.json"))
try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}".utf8).write(to:folder.deletingLastPathComponent().appendingPathComponent("Contents.json"))
