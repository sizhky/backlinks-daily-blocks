import XCTest
@testable import KanbanCore

final class ProjectColorTests: XCTestCase {
  func testZeroChromaIsGray() {
    let (r, g, b) = OKLCH(l: 0.7, c: 0, h: 123).rgb
    XCTAssertEqual(r, g, accuracy: 1e-6)
    XCTAssertEqual(g, b, accuracy: 1e-6)
  }

  func testWhiteAndBlack() {
    let white = OKLCH(l: 1, c: 0, h: 0).rgb, black = OKLCH(l: 0, c: 0, h: 0).rgb
    XCTAssertEqual(white.r, 1, accuracy: 1e-3)
    XCTAssertEqual(black.r, 0, accuracy: 1e-3)
  }

  func testChannelsStayInGamut() {
    for name in ["Arka", "AAA", "Obsidian Workflow", "Kanban App", "Levo", "x"] {
      let pair = ProjectColor.pair(name)
      for c in [pair.light, pair.dark] {
        for v in [c.rgb.r, c.rgb.g, c.rgb.b] { XCTAssertTrue((0...1).contains(v), "\(name) \(v)") }
      }
    }
  }

  func testDeterministicAndSpread() {
    XCTAssertEqual(ProjectColor.hue("Arka"), ProjectColor.hue("Arka"))
    let names = ["Arka", "AAA", "Obsidian Workflow", "Kanban App", "Levo", "Yaksh", "Vyasa", "Divami"]
    XCTAssertEqual(Set(names.map { Int(ProjectColor.hue($0)) / 30 }).count >= 5, true)
  }

  func testPickedHueOverridesHash() {
    XCTAssertEqual(ProjectColor.pair("Arka", base: OKLCH(l: 0.6, c: 0.1, h: 145)).light.h, 145)
    XCTAssertEqual(ProjectColor.pair("Arka").light.h, ProjectColor.hue("Arka"))
  }

  func testPaletteIsFortyDistinctColours() {
    let p = ProjectColor.palette
    XCTAssertEqual(p.count, 40)
    func lab(_ c: OKLCH) -> [Double] { [c.l, c.c * cos(c.h * .pi / 180), c.c * sin(c.h * .pi / 180)] }
    for (i, a) in p.enumerated() {
      for b in p[(i + 1)...] {
        let d = zip(lab(a), lab(b)).map { ($0 - $1) * ($0 - $1) }.reduce(0, +).squareRoot()
        XCTAssertGreaterThan(d, 0.05, "\(a) \(b)")
      }
    }
  }
}
