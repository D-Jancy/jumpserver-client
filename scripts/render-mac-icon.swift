#!/usr/bin/env swift
import AppKit
import Foundation

/// Render the source SVG into a 1024×1024 PNG with a transparent
/// background. Artwork is fitted to Apple's 824pt macOS icon grid so
/// Dock / Launchpad size matches native apps when bundled as .icns.

let canvas = 1024
let content = 824
let renderScale = 2

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(1)
}

func makeRep(width: Int, height: Int) -> NSBitmapImageRep {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: width * 4,
        bitsPerPixel: 32
    ) else {
        fail("failed to create bitmap \(width)x\(height)")
    }
    rep.size = NSSize(width: width, height: height)
    return rep
}

func withContext(_ rep: NSBitmapImageRep, _ body: () -> Void) {
    NSGraphicsContext.saveGraphicsState()
    guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else {
        fail("failed to create graphics context")
    }
    ctx.imageInterpolation = .high
    ctx.shouldAntialias = true
    NSGraphicsContext.current = ctx
    NSColor.clear.setFill()
    NSRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh).fill()
    body()
    NSGraphicsContext.restoreGraphicsState()
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: render-mac-icon.swift <in.svg> <out.png>")
}

let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let source = NSImage(contentsOf: inURL) else {
    fail("failed to load \(inURL.path)")
}

let hiRes = canvas * renderScale
let hiRep = makeRep(width: hiRes, height: hiRes)
withContext(hiRep) {
    source.draw(
        in: NSRect(x: 0, y: 0, width: hiRes, height: hiRes),
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
}

guard let data = hiRep.bitmapData else {
    fail("missing bitmap data")
}

var minX = hiRes, minY = hiRes, maxX = -1, maxY = -1
let alphaThreshold: UInt8 = 12
for y in 0..<hiRes {
    for x in 0..<hiRes {
        let a = data[(y * hiRes + x) * 4 + 3]
        if a > alphaThreshold {
            if x < minX { minX = x }
            if y < minY { minY = y }
            if x > maxX { maxX = x }
            if y > maxY { maxY = y }
        }
    }
}

guard maxX >= minX, maxY >= minY else {
    fail("rendered SVG has no opaque pixels")
}

let margin = 4 * renderScale
minX = max(0, minX - margin)
minY = max(0, minY - margin)
maxX = min(hiRes - 1, maxX + margin)
maxY = min(hiRes - 1, maxY + margin)

let bboxW = maxX - minX + 1
let bboxH = maxY - minY + 1
let scale = min(CGFloat(content) / CGFloat(bboxW), CGFloat(content) / CGFloat(bboxH)) * CGFloat(renderScale)
let dstW = CGFloat(bboxW) * scale / CGFloat(renderScale)
let dstH = CGFloat(bboxH) * scale / CGFloat(renderScale)

guard let srcCG = hiRep.cgImage else {
    fail("failed to get hires CGImage")
}
let cropRect = CGRect(x: minX, y: minY, width: bboxW, height: bboxH)
guard let cropped = srcCG.cropping(to: cropRect) else {
    fail("failed to crop artwork")
}
let croppedImage = NSImage(cgImage: cropped, size: NSSize(width: bboxW, height: bboxH))

let outRep = makeRep(width: canvas, height: canvas)
let drawRect = NSRect(
    x: (CGFloat(canvas) - dstW) / 2,
    y: (CGFloat(canvas) - dstH) / 2,
    width: dstW,
    height: dstH
)
withContext(outRep) {
    croppedImage.draw(
        in: drawRect,
        from: .zero,
        operation: .sourceOver,
        fraction: 1.0,
        respectFlipped: true,
        hints: [.interpolation: NSImageInterpolation.high]
    )
}

guard let png = outRep.representation(using: .png, properties: [:]) else {
    fail("failed to encode png")
}
try png.write(to: outURL)

let rel = String(format: "%.1f", Double(content) / Double(canvas) * 100)
FileHandle.standardError.write(Data(
    """
    rendered \(outURL.path)
      source bbox: (\(minX),\(minY))-(\(maxX),\(maxY)) @\(hiRes)
      fitted: \(Int(drawRect.width.rounded()))x\(Int(drawRect.height.rounded())) in \(canvas) (Apple grid \(content)/\(canvas) = \(rel)%)
    """.utf8
))
FileHandle.standardError.write(Data("\n".utf8))
