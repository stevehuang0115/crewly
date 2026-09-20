// =============================================================================
// desktop-perceive — the eyes of Crewly's desktop control.
//
// Phase 2 of docs/research/computer-use-capability-assessment.md. Until now an
// agent driving the desktop saw pixels: it took a screenshot and guessed
// coordinates, so it misclicked, it re-sent a whole image every step, and any
// change of theme, resolution or window position broke it.
//
// This gives it elements instead. One accessibility snapshot returns a flat
// list of refs (@e1, @e2 …) an agent can act on by name, the way the browser
// line already works with DOM selectors and agent-browser works with its own
// refs — so an agent learns one idea, not three.
//
// Written in Swift rather than JXA because the scripting bridge costs a round
// trip per attribute: reading one mid-sized window took seconds, which is too
// slow to do before every action. Raw AXUIElement reads the same tree in
// milliseconds, and Vision (for OCR) lives in the same binary.
//
// Subcommands:
//   snapshot [--app NAME] [--max N] [--all-windows] [--menus]   elements of an app
//   resolve --ref @eN                                  re-find one element
//   ocr [--region x,y,w,h] [--image PATH]              text and its boxes
//   displays                                           screens and their frames
//
// Every subcommand prints one JSON object on stdout.
// =============================================================================

import AppKit
import ApplicationServices
import Foundation
import Vision

// MARK: - Output

/// Print a JSON object and exit. All output goes through here so a caller can
/// always parse stdout, including on failure.
func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data ?? Data("{}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

/// Fail in the same shape the shell guards use, so an agent parses one format.
func fail(_ reason: String, _ message: String, extra: [String: Any] = [:]) -> Never {
    var out: [String: Any] = ["success": false, "reason": reason, "message": message]
    out.merge(extra) { a, _ in a }
    emit(out, exitCode: 1)
}

// MARK: - Accessibility helpers

/// Read one attribute, returning nil rather than throwing — most elements are
/// missing most attributes and that is normal, not an error.
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func stringAttr(_ element: AXUIElement, _ name: String) -> String? {
    guard let raw = attr(element, name) else { return nil }
    if let s = raw as? String { return s.isEmpty ? nil : s }
    if let n = raw as? NSNumber { return n.stringValue }
    return nil
}

func boolAttr(_ element: AXUIElement, _ name: String) -> Bool? {
    (attr(element, name) as? NSNumber)?.boolValue
}

/// Screen frame of an element, in the top-left origin coordinates the rest of
/// the skill uses (AX already reports top-left, unlike AppKit).
func frameOf(_ element: AXUIElement) -> CGRect? {
    guard let posRaw = attr(element, kAXPositionAttribute as String),
          let sizeRaw = attr(element, kAXSizeAttribute as String) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    // swiftlint:disable:next force_cast
    guard AXValueGetValue(posRaw as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeRaw as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
    (attr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

// MARK: - Snapshot

/// One element as an agent sees it.
///
/// `path` is how the element is found again in a later process: the child
/// indices from the application root. AXUIElement handles cannot cross a
/// process boundary, so the ref must be re-resolved, and the role/title/frame
/// travel with it so re-resolution can be checked rather than assumed.
struct Node {
    let ref: String
    let role: String
    let subrole: String?
    let name: String?
    let value: String?
    let frame: CGRect?
    let enabled: Bool?
    let focused: Bool?
    let path: [Int]

    var json: [String: Any] {
        var out: [String: Any] = ["ref": ref, "role": role, "path": path]
        if let subrole { out["subrole"] = subrole }
        if let name { out["name"] = name }
        if let value { out["value"] = value }
        if let frame {
            out["frame"] = [Int(frame.origin.x), Int(frame.origin.y), Int(frame.width), Int(frame.height)]
        }
        if let enabled { out["enabled"] = enabled }
        if focused == true { out["focused"] = true }
        return out
    }
}

/// Roles that carry no information on their own. Keeping them would triple the
/// list an agent has to read for nothing — an agent acts on buttons and fields,
/// not on the groups that hold them.
let skeletalRoles: Set<String> = [
    "AXGroup", "AXSplitGroup", "AXScrollArea", "AXLayoutArea", "AXLayoutItem",
    "AXUnknown", "AXSplitter", "AXGrowArea",
]

/// Roles worth reporting even with no title — an agent may still need to click
/// or read them.
let alwaysKeepRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSlider",
    "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXWindow", "AXSheet", "AXTable", "AXList",
]

/// Walk an application's accessibility tree into a flat list.
///
/// Flat, not nested, because an agent has to name one element, not navigate a
/// structure; the `path` field keeps the structure available where it matters.
func snapshot(app: AXUIElement, limit: Int, allWindows: Bool, includeMenus: Bool) -> [Node] {
    var out: [Node] = []
    var counter = 0

    // Depth cap alongside the node cap: a runaway tree (a huge table) would
    // otherwise spend the whole budget on one branch and miss the toolbar.
    func walk(_ element: AXUIElement, path: [Int], depth: Int) {
        if out.count >= limit || depth > 24 { return }

        let role = stringAttr(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let name = stringAttr(element, kAXTitleAttribute as String)
            ?? stringAttr(element, kAXDescriptionAttribute as String)
            ?? stringAttr(element, "AXLabel")
        let rawValue = stringAttr(element, kAXValueAttribute as String)
        // A long text area would otherwise dominate the output.
        let value = rawValue.map { $0.count > 200 ? String($0.prefix(200)) + "…" : $0 }
        let frame = frameOf(element)

        // Zero-sized and offscreen elements are real in the tree but cannot be
        // clicked, so reporting them only invites the agent to try.
        let visible = frame.map { $0.width > 1 && $0.height > 1 } ?? false
        let informative = !skeletalRoles.contains(role) && (name != nil || value != nil || alwaysKeepRoles.contains(role))

        if visible && informative {
            counter += 1
            out.append(Node(
                ref: "@e\(counter)",
                role: role,
                subrole: stringAttr(element, kAXSubroleAttribute as String),
                name: name,
                value: value,
                frame: frame,
                enabled: boolAttr(element, kAXEnabledAttribute as String),
                focused: boolAttr(element, kAXFocusedAttribute as String),
                path: path
            ))
        }

        for (index, child) in childrenOf(element).enumerated() {
            walk(child, path: path + [index], depth: depth + 1)
        }
    }

    // Which subtrees to walk, and in what order. This matters more than it
    // looks: the menu bar is an app's first child and carries every menu of
    // every menu title, so walking the app root spends the whole budget on
    // "Apple / File / Edit / View" and never reaches the window the agent
    // asked about. Windows come first, and the menu bar only when asked for.
    let appChildren = childrenOf(app)
    func indexOf(_ element: AXUIElement) -> Int {
        appChildren.firstIndex { CFEqual($0, element) } ?? 0
    }

    let windows = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    let focused = attr(app, kAXFocusedWindowAttribute as String).map { unsafeBitCast($0, to: AXUIElement.self) }

    var roots: [AXUIElement] = []
    if allWindows {
        roots = windows
    } else if let focused {
        roots = [focused]
    } else if let first = windows.first {
        roots = [first]
    }
    if includeMenus || roots.isEmpty {
        // No window at all (a menu-bar-only app, or everything minimised):
        // the menu bar is then the only thing there is to act on.
        if let menuBar = attr(app, kAXMenuBarAttribute as String).map({ unsafeBitCast($0, to: AXUIElement.self) }) {
            roots.append(menuBar)
        }
    }
    if roots.isEmpty { roots = [app] }

    for root in roots { walk(root, path: [indexOf(root)], depth: 0) }
    return out
}

/// The application to snapshot: the one named, else whatever is in front.
func targetApp(named: String?) -> (AXUIElement, String, pid_t) {
    let running = NSWorkspace.shared.runningApplications
    let chosen: NSRunningApplication?
    if let named {
        chosen = running.first {
            $0.localizedName?.compare(named, options: .caseInsensitive) == .orderedSame
                || $0.bundleIdentifier?.compare(named, options: .caseInsensitive) == .orderedSame
        }
    } else {
        chosen = NSWorkspace.shared.frontmostApplication
    }
    guard let appProcess = chosen, let pid = Optional(appProcess.processIdentifier) else {
        fail("app_not_found",
             named.map { "No running application called \($0). Use list-apps to see what is open." }
                 ?? "Could not determine the frontmost application.")
    }
    return (AXUIElementCreateApplication(pid), appProcess.localizedName ?? "unknown", pid)
}

// MARK: - Ref cache
//
// A ref is only meaningful next to the snapshot that minted it, so the cache
// records which app and which snapshot, and `resolve` refuses a ref from a
// different app rather than acting on whatever happens to sit at that path.

let cacheURL: URL = {
    let home = ProcessInfo.processInfo.environment["CREWLY_HOME"]
        ?? (NSHomeDirectory() as NSString).appendingPathComponent(".crewly")
    try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    return URL(fileURLWithPath: (home as NSString).appendingPathComponent("desktop-refs.json"))
}()

func writeCache(app: String, pid: pid_t, nodes: [Node]) {
    var refs: [String: Any] = [:]
    for node in nodes {
        refs[node.ref] = [
            "path": node.path, "role": node.role,
            "name": node.name ?? "", "frame": node.frame.map { [$0.midX, $0.midY] } ?? [],
        ]
    }
    let payload: [String: Any] = ["app": app, "pid": Int(pid), "at": Date().timeIntervalSince1970, "refs": refs]
    try? JSONSerialization.data(withJSONObject: payload).write(to: cacheURL)
}

/// Re-find a ref in the live tree.
///
/// Walking the recorded path can land on a different element if the window
/// changed, so the role is checked and the name compared. A mismatch is
/// reported rather than hidden: the caller decides whether to click the last
/// known position or take a fresh snapshot.
func resolve(ref: String) -> [String: Any] {
    guard let data = try? Data(contentsOf: cacheURL),
          let cache = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let refs = cache["refs"] as? [String: Any],
          let entry = refs[ref] as? [String: Any] else {
        fail("unknown_ref", "\(ref) is not in the last snapshot. Take a snapshot first.")
    }

    let expectedRole = entry["role"] as? String ?? ""
    let expectedName = entry["name"] as? String ?? ""
    let path = entry["path"] as? [Int] ?? []
    let lastKnown = entry["frame"] as? [Double] ?? []
    let appName = cache["app"] as? String ?? ""

    let (app, liveName, _) = targetApp(named: appName)
    if liveName.compare(appName, options: .caseInsensitive) != .orderedSame {
        fail("app_changed",
             "\(ref) was captured in \(appName) but \(liveName) is in front now. Take a new snapshot.",
             extra: ["expectedApp": appName, "actualApp": liveName])
    }

    var element = app
    for index in path {
        let kids = childrenOf(element)
        guard index < kids.count else {
            return ["success": false, "reason": "ref_stale", "ref": ref,
                    "message": "\(ref) no longer exists — the window changed. Take a new snapshot.",
                    "lastKnownCenter": lastKnown]
        }
        element = kids[index]
    }

    let role = stringAttr(element, kAXRoleAttribute as String) ?? ""
    let name = stringAttr(element, kAXTitleAttribute as String)
        ?? stringAttr(element, kAXDescriptionAttribute as String) ?? ""
    let frame = frameOf(element)
    let matches = role == expectedRole && (expectedName.isEmpty || name == expectedName)

    var out: [String: Any] = [
        "success": true, "ref": ref, "role": role, "name": name,
        "matches": matches,
        "center": frame.map { [Int($0.midX), Int($0.midY)] } ?? lastKnown.map { Int($0) },
    ]
    if !matches {
        out["warning"] = "The element at this position is now \(role) \"\(name)\", not \(expectedRole) \"\(expectedName)\". Take a new snapshot before acting."
    }
    // Whether it can be pressed directly decides if the caller needs a click.
    var actions: CFArray?
    if AXUIElementCopyActionNames(element, &actions) == .success,
       let names = actions as? [String] {
        out["actions"] = names
        out["pressable"] = names.contains(kAXPressAction as String)
    }
    return out
}

/// Perform AXPress on a ref. Returns false when the element has no press
/// action, so the caller can fall back to clicking its centre.
func press(ref: String) -> [String: Any] {
    let info = resolve(ref: ref)
    guard info["success"] as? Bool == true else { return info }
    guard let cacheData = try? Data(contentsOf: cacheURL),
          let cache = try? JSONSerialization.jsonObject(with: cacheData) as? [String: Any],
          let refs = cache["refs"] as? [String: Any],
          let entry = refs[ref] as? [String: Any],
          let path = entry["path"] as? [Int] else {
        return ["success": false, "reason": "unknown_ref", "ref": ref]
    }
    let (app, _, _) = targetApp(named: cache["app"] as? String)
    var element = app
    for index in path {
        let kids = childrenOf(element)
        guard index < kids.count else { return ["success": false, "reason": "ref_stale", "ref": ref] }
        element = kids[index]
    }
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    return ["success": result == .success, "ref": ref, "method": "AXPress",
            "center": info["center"] ?? [], "axError": result == .success ? 0 : Int(result.rawValue)]
}

/// Set a text field's value directly. Far more reliable than typing, which
/// depends on focus and on the keyboard layout.
func setValue(ref: String, text: String) -> [String: Any] {
    guard let cacheData = try? Data(contentsOf: cacheURL),
          let cache = try? JSONSerialization.jsonObject(with: cacheData) as? [String: Any],
          let refs = cache["refs"] as? [String: Any],
          let entry = refs[ref] as? [String: Any],
          let path = entry["path"] as? [Int] else {
        fail("unknown_ref", "\(ref) is not in the last snapshot. Take a snapshot first.")
    }
    let (app, _, _) = targetApp(named: cache["app"] as? String)
    var element = app
    for index in path {
        let kids = childrenOf(element)
        guard index < kids.count else { return ["success": false, "reason": "ref_stale", "ref": ref] }
        element = kids[index]
    }
    let role = stringAttr(element, kAXRoleAttribute as String) ?? ""
    if role == "AXSecureTextField" {
        fail("secure_field", "\(ref) is a password field. Desktop control never fills one — ask the owner.")
    }
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
    return ["success": result == .success, "ref": ref, "role": role,
            "axError": result == .success ? 0 : Int(result.rawValue)]
}

// MARK: - OCR

/// Read the text on screen, with a box for each piece.
///
/// Vision runs locally and free, handles Chinese and English, and covers what
/// the accessibility tree does not expose — a canvas, a PDF page, an app that
/// simply does not implement AX.
func ocr(region: CGRect?, imagePath: String?) -> [String: Any] {
    // Capture via `screencapture` rather than CoreGraphics: CGDisplayCreateImage
    // was obsoleted in macOS 15 and its replacement, ScreenCaptureKit, is async
    // and far heavier than this needs. The shell tool is also what the rest of
    // the skill already uses, so one TCC grant covers both.
    let path: String
    var temporary: String?
    if let imagePath {
        path = imagePath
    } else {
        let scratch = NSTemporaryDirectory() + "crewly-ocr-\(getpid()).png"
        var args = ["-x"]
        if let region {
            args += ["-R", "\(Int(region.origin.x)),\(Int(region.origin.y)),\(Int(region.width)),\(Int(region.height))"]
        }
        args.append(scratch)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        task.arguments = args
        try? task.run()
        task.waitUntilExit()
        guard FileManager.default.fileExists(atPath: scratch) else {
            fail("screenshot_failed",
                 "screencapture produced nothing. Screen Recording is probably not granted to this process.",
                 extra: ["permission": "screen-recording"])
        }
        path = scratch
        temporary = scratch
    }
    defer { if let temporary { try? FileManager.default.removeItem(atPath: temporary) } }

    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("bad_image", "Could not read the image at \(path).")
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]

    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        fail("ocr_failed", "Vision could not read the image: \(error.localizedDescription)")
    }

    // screencapture writes backing pixels; the rest of the skill speaks screen
    // points, so divide by the scale of the display the region came from.
    let scale = NSScreen.main.map { Double($0.backingScaleFactor) } ?? 2.0
    let widthPoints = Double(image.width) / scale
    let heightPoints = Double(image.height) / scale
    let originX = Double(region?.origin.x ?? 0)
    let originY = Double(region?.origin.y ?? 0)

    var items: [[String: Any]] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        // Vision reports a unit box with a bottom-left origin; screen points
        // run from the top left.
        let box = observation.boundingBox
        let x = originX + Double(box.origin.x) * widthPoints
        let y = originY + (1 - Double(box.origin.y) - Double(box.height)) * heightPoints
        let w = Double(box.width) * widthPoints
        let h = Double(box.height) * heightPoints
        items.append([
            "text": candidate.string,
            "confidence": Double(round(candidate.confidence * 100) / 100),
            "frame": [Int(x), Int(y), Int(w), Int(h)],
            "center": [Int(x + w / 2), Int(y + h / 2)],
        ])
    }
    return ["success": true, "action": "ocr", "count": items.count, "items": items]
}

// MARK: - Displays

func displays() -> [String: Any] {
    let screens = NSScreen.screens.enumerated().map { index, screen -> [String: Any] in
        let frame = screen.frame
        return [
            "index": index,
            "frame": [Int(frame.origin.x), Int(frame.origin.y), Int(frame.width), Int(frame.height)],
            "scale": Double(screen.backingScaleFactor),
            "main": screen == NSScreen.main,
        ]
    }
    return ["success": true, "action": "displays", "count": screens.count, "displays": screens]
}

// MARK: - Entry

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage", "Usage: desktop-perceive snapshot|resolve|press|set-value|ocr|displays [options]")
}
args = Array(args.dropFirst())

func option(_ name: String) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

// Every subcommand but `displays` reads the accessibility tree or the screen.
if command != "displays" && !AXIsProcessTrusted() {
    fail("permission_required",
         "Accessibility is not granted to this process, so the element tree is invisible.",
         extra: ["permission": "accessibility",
                 "howTo": "System Settings → Privacy & Security → Accessibility"])
}

switch command {
case "snapshot":
    let limit = Int(option("--max") ?? "") ?? 200
    let (app, name, pid) = targetApp(named: option("--app"))
    let nodes = snapshot(app: app, limit: limit, allWindows: args.contains("--all-windows"),
                         includeMenus: args.contains("--menus"))
    writeCache(app: name, pid: pid, nodes: nodes)
    emit(["success": true, "action": "snapshot", "app": name, "count": nodes.count,
          "truncated": nodes.count >= limit, "elements": nodes.map(\.json)])

case "resolve":
    guard let ref = option("--ref") else { fail("usage", "resolve needs --ref @eN") }
    emit(resolve(ref: ref))

case "press":
    guard let ref = option("--ref") else { fail("usage", "press needs --ref @eN") }
    emit(press(ref: ref))

case "set-value":
    guard let ref = option("--ref"), let text = option("--text") else {
        fail("usage", "set-value needs --ref @eN --text STRING")
    }
    emit(setValue(ref: ref, text: text))

case "ocr":
    var region: CGRect?
    if let spec = option("--region") {
        let parts = spec.split(separator: ",").compactMap { Double($0) }
        guard parts.count == 4 else { fail("usage", "--region takes x,y,w,h") }
        region = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }
    emit(ocr(region: region, imagePath: option("--image")))

case "displays":
    emit(displays())

default:
    fail("usage", "Unknown subcommand \(command). Use snapshot, resolve, press, set-value, ocr or displays.")
}
