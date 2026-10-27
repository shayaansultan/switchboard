// The smallest SMC client fan control needs. Reads work as any user; writes
// need root, so only the system helper calls write. Layout mirrors the C
// SMCParamStruct (80 bytes); Swift packs a nested struct by size, not stride,
// so KeyInfo carries explicit padding or every field after it shifts.
import Foundation
import IOKit

struct SMCKeyInfo {
  var dataSize: UInt32 = 0
  var dataType: UInt32 = 0
  var attributes: UInt8 = 0
  var pad = (UInt8(0), UInt8(0), UInt8(0))
}

struct SMCParam {
  var key: UInt32 = 0
  var vers = (UInt8(0), UInt8(0), UInt8(0), UInt8(0), UInt16(0))
  var pLimit = (UInt16(0), UInt16(0), UInt32(0), UInt32(0), UInt32(0))
  var info = SMCKeyInfo()
  var result: UInt8 = 0
  var status: UInt8 = 0
  var command: UInt8 = 0
  var data32: UInt32 = 0
  var bytes: (
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
    UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8
  ) = (
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  )
}

enum SMCError: Error { case open, call(String), type(String) }

final class SMC {
  private var connection: io_connect_t = 0
  private var infoCache: [String: SMCKeyInfo] = [:]

  init() throws {
    precondition(MemoryLayout<SMCParam>.stride == 80, "SMCParam layout drifted")
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"))
    guard service != 0, IOServiceOpen(service, mach_task_self_, 0, &connection) == kIOReturnSuccess
    else { throw SMCError.open }
    IOObjectRelease(service)
  }

  deinit { IOServiceClose(connection) }

  static func code(_ name: String) -> UInt32 { name.utf8.reduce(0) { $0 << 8 | UInt32($1) } }
  static func name(_ code: UInt32) -> String {
    String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }, encoding: .ascii) ?? "????"
  }

  private func call(_ input: SMCParam) throws -> SMCParam {
    var input = input
    var output = SMCParam()
    var size = MemoryLayout<SMCParam>.stride
    let result = IOConnectCallStructMethod(connection, 2, &input, size, &output, &size)
    guard result == kIOReturnSuccess, output.result == 0 else {
      throw SMCError.call("\(SMC.name(input.key)) kr=\(result) smc=\(output.result)")
    }
    return output
  }

  func info(_ key: String) throws -> SMCKeyInfo {
    if let cached = infoCache[key] { return cached }
    var param = SMCParam()
    param.key = SMC.code(key)
    param.command = 9
    let info = try call(param).info
    infoCache[key] = info
    return info
  }

  func exists(_ key: String) -> Bool { (try? info(key)) != nil }

  /// Every key the SMC lists, in its own order.
  func allKeys() throws -> [String] {
    var count = SMCParam()
    count.key = SMC.code("#KEY")
    count.info.dataSize = 4
    count.command = 5
    let raw = withUnsafeBytes(of: try call(count).bytes) { Array($0.prefix(4)) }
    let total = Int(raw[0]) << 24 | Int(raw[1]) << 16 | Int(raw[2]) << 8 | Int(raw[3])
    return try (0..<min(total, 4096)).map { index in
      var param = SMCParam()
      param.command = 8
      param.data32 = UInt32(index)
      return SMC.name(try call(param).key)
    }
  }

  func readBytes(_ key: String) throws -> (type: String, bytes: [UInt8]) {
    let info = try info(key)
    var param = SMCParam()
    param.key = SMC.code(key)
    param.info.dataSize = info.dataSize
    param.command = 5
    let output = try call(param)
    let all = withUnsafeBytes(of: output.bytes) { Array($0) }
    return (SMC.name(info.dataType), Array(all.prefix(Int(info.dataSize))))
  }

  func writeBytes(_ key: String, _ bytes: [UInt8]) throws {
    let info = try info(key)
    guard bytes.count == Int(info.dataSize) else { throw SMCError.type("\(key) size") }
    var param = SMCParam()
    param.key = SMC.code(key)
    param.info.dataSize = info.dataSize
    param.command = 6
    withUnsafeMutableBytes(of: &param.bytes) { raw in
      for (index, byte) in bytes.enumerated() { raw[index] = byte }
    }
    _ = try call(param)
  }

  func readNumber(_ key: String) throws -> Double {
    let (type, bytes) = try readBytes(key)
    switch type {
    case "flt ": return Double(bytes.withUnsafeBytes { $0.loadUnaligned(as: Float.self) })
    case "ui8 ": return Double(bytes[0])
    case "ui16": return Double(UInt16(bytes[0]) << 8 | UInt16(bytes[1]))
    case "fpe2": return Double(Int(bytes[0]) << 6 | Int(bytes[1]) >> 2)
    default: throw SMCError.type("\(key) is \(type)")
    }
  }

  func writeNumber(_ key: String, _ value: Double) throws {
    let info = try info(key)
    switch SMC.name(info.dataType) {
    case "flt ":
      var float = Float(value)
      try writeBytes(key, withUnsafeBytes(of: &float) { Array($0) })
    case "fpe2":
      let raw = UInt16(max(0, min(16383, value.rounded()))) << 2
      try writeBytes(key, [UInt8(raw >> 8), UInt8(raw & 0xff)])
    case "ui8 ":
      try writeBytes(key, [UInt8(max(0, min(255, value.rounded())))])
    default:
      throw SMCError.type("\(key) is \(SMC.name(info.dataType))")
    }
  }
}
