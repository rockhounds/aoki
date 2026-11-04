// SPDX-FileCopyrightText: 2026 Aoki contributors
// SPDX-License-Identifier: MIT
import AppKit
let image = NSImage(size: NSSize(width: 1024, height: 1024))
image.lockFocus()
NSColor(white: 0.97, alpha: 1).setFill()
NSBezierPath(rect: NSRect(x: 0,y: 0,width: 1024,height: 1024)).fill()
let font = NSFont.systemFont(ofSize: 290, weight: .black)
let text = "Aoki" as NSString
let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(white: 0.13, alpha: 1)]
let size = text.size(withAttributes: attributes)
text.draw(at: NSPoint(x: (1024-size.width)/2, y: (1024-size.height)/2), withAttributes: attributes)
image.unlockFocus()
let source = NSBitmapImageRep(data: image.tiffRepresentation!)!
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.draw(source.cgImage!, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
let data = bitmap.representation(using: .png, properties: [:])!
for path in CommandLine.arguments.dropFirst() { try data.write(to: URL(fileURLWithPath:path)) }
