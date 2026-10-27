// What the fan helper and the fan bridge agree on: names, the XPC protocol,
// the status they exchange, and how a speed level maps onto a fan. Both are
// built from this file, so there is one definition of each.
//
// Neither side hard-codes a signing team. Each reads its own team from its
// signature and only trusts the other when it carries the same team, so an
// install signed with any certificate works, and an ad-hoc build (no team)
// never reaches the helper at all.
import Foundation
import Security

enum FanNames {
  static let helper = "dev.shayaan.switchboard.fan-helper"
  static let bridge = "dev.shayaan.switchboard.fan-bridge"
  static let plist = "\(helper).plist"
  static let heartbeatLimit: TimeInterval = 7
  /// Missed checks in a row before the helper decides macOS took the fans back.
  static let takeoverLimit = 3

  static func requirement(identifier: String, team: String) -> String {
    "identifier \"\(identifier)\" and anchor apple generic and certificate leaf[subject.OU] = \"\(team)\""
  }
}

/// The team this process is signed with, or nil for an ad-hoc signature.
func ownSigningTeam() -> String? {
  var code: SecCode?
  guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
  var info: CFDictionary?
  guard
    SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
      == errSecSuccess,
    let values = info as? [String: Any]
  else { return nil }
  return values[kSecCodeInfoTeamIdentifier as String] as? String
}

@objc protocol FanHelperProtocol {
  func status(reply: @escaping (Data) -> Void)
  /// A level from 0 to 100 in steps of 5, held for `seconds` (0: until told).
  func setLevel(_ level: Int, seconds: Int, reply: @escaping (Data) -> Void)
  func restoreSystem(reply: @escaping (Data) -> Void)
  func heartbeat(reply: @escaping (Data) -> Void)
}

struct FanReading: Codable {
  var actual: Double
  var minimum: Double
  var maximum: Double
  var target: Double
  var manual: Bool
}

struct FanStatus: Codable {
  var fans: [FanReading]
  var temperature: Double?
  var controlling: Bool
  var level: Int?
  var endsIn: Int?
  var stop: String?
  var error: String?
  var detail: String?
}

func encode<T: Encodable>(_ value: T) -> Data {
  (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
}

func validLevel(_ level: Int) -> Bool { (0...100).contains(level) && level % 5 == 0 }

func targetRPM(minimum: Double, maximum: Double, level: Int) -> Double {
  minimum + (maximum - minimum) * Double(level) / 100
}

extension SMC {
  func modeKey(_ index: Int) -> String? {
    ["F\(index)md", "F\(index)Md"].first { exists($0) }
  }

  func fanCount() throws -> Int {
    guard exists("FNum") else { return 0 }
    let count = Int(try readNumber("FNum"))
    guard (0...8).contains(count) else { throw SMCError.type("FNum \(count)") }
    return count
  }

  func readings() throws -> [FanReading] {
    try (0..<fanCount()).map { index in
      guard let mode = modeKey(index) else { throw SMCError.type("no mode key for fan \(index)") }
      let minimum = try readNumber("F\(index)Mn")
      let maximum = try readNumber("F\(index)Mx")
      guard minimum >= 0, maximum > minimum, maximum <= 20_000 else {
        throw SMCError.type("fan \(index) range \(minimum)-\(maximum)")
      }
      return FanReading(
        actual: try readNumber("F\(index)Ac"),
        minimum: minimum,
        maximum: maximum,
        target: try readNumber("F\(index)Tg"),
        manual: try readNumber(mode) == 1
      )
    }
  }
}

/// The hottest CPU sensor, in °C. Apple silicon names its CPU sensors Tp…,
/// but not every Tp key is live: some hold fixed placeholders (40.0, -4.0,
/// 0 on an M4 Pro). Those read as whole numbers or below any working
/// temperature, so keys are kept only if they read like a live sensor when
/// first listed. Intel Macs report the package as TC0P. The list is kept once
/// it finds a sensor; an empty or stale listing is tried again on the next read.
final class CPUTemperature {
  private let smc: SMC
  private var keys: [String] = []

  init(smc: SMC) { self.smc = smc }

  static func plausible(_ value: Double) -> Bool { value >= 20 && value <= 110 }

  private func discover() -> [String] {
    let all = (try? smc.allKeys()) ?? []
    let readings = all.filter { $0.hasPrefix("Tp") }.compactMap { key in (try? smc.readNumber(key)).map { (key, $0) } }
    // Now and then the SMC answers every key with one stale value; real
    // sensors never agree exactly, so treat that as no reading and retry.
    guard Set(readings.map(\.1)).count > 1 else { return [] }
    let live = readings.filter { CPUTemperature.plausible($0.1) && $0.1.rounded() != $0.1 }.map(\.0)
    return live.isEmpty ? all.filter { $0 == "TC0P" || $0 == "TC0D" } : live
  }

  func hottest() -> Double? {
    if keys.isEmpty { keys = discover() }
    let values = keys.compactMap { try? smc.readNumber($0) }
    guard values.count < 2 || Set(values).count > 1 else { return nil }
    return values.filter(CPUTemperature.plausible).max()
  }
}
