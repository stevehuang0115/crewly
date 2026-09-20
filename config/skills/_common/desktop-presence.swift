// =============================================================================
// desktop-presence — telling the owner an agent has the mouse, and letting
// them take it back.
//
// Phase 5 of docs/research/computer-use-capability-assessment.md. The browser
// line has had a takeover banner since April: when an agent drives Chrome the
// user sees who it is and what they are trying to do. The desktop had nothing
// — the pointer simply started moving. That is the difference between
// automation and a haunting, and it is why desktop control could not be
// handed to anyone.
//
// Three things, all of which need one long-lived process:
//
//   A banner   — who is acting, at what, with Pause and Stop.
//   A hotkey   — ⌃⌥⌘. stops everything from anywhere, including while an
//                agent holds the keyboard.
//   An eye     — real mouse or keyboard input from the owner pauses the
//                agent immediately, because someone reaching for the mouse
//                is not asking politely.
//
// It owns no policy. It writes the same two files the shell rails already
// read (`desktop.stop`, `desktop.pause`), so there is one enforcement point
// and this process can die without anything being left un-enforced.
//
// Subcommands:
//   begin --agent NAME --goal TEXT   show/refresh the banner (starts if idle)
//   end                              hide the banner and exit
//   status                           JSON: running, paused, stopped
//
// =============================================================================

import AppKit
import ApplicationServices
import Foundation

// MARK: - Paths

let crewlyHome: String = ProcessInfo.processInfo.environment["CREWLY_HOME"]
    ?? (NSHomeDirectory() as NSString).appendingPathComponent(".crewly")

let stateURL = URL(fileURLWithPath: (crewlyHome as NSString).appendingPathComponent("desktop-presence.json"))
let stopURL = URL(fileURLWithPath: (crewlyHome as NSString).appendingPathComponent("desktop.stop"))
let pauseURL = URL(fileURLWithPath: (crewlyHome as NSString).appendingPathComponent("desktop.pause"))

/// How long after the last `begin` the banner gives up and exits.
///
/// The shell refreshes it before each action, so this only fires when the
/// agent has stopped — a crashed agent must not leave a banner on screen
/// claiming it is still working.
let IDLE_EXIT_SECONDS: TimeInterval = 45

// MARK: - Shared state

/// What the banner is currently saying, written by `begin`.
struct Presence: Codable {
    var agent: String
    var goal: String
    var updatedAt: TimeInterval
}

func readPresence() -> Presence? {
    guard let data = try? Data(contentsOf: stateURL) else { return nil }
    return try? JSONDecoder().decode(Presence.self, from: data)
}

func writePresence(_ presence: Presence) {
    try? FileManager.default.createDirectory(atPath: crewlyHome, withIntermediateDirectories: true)
    try? JSONEncoder().encode(presence).write(to: stateURL)
}

func emit(_ object: [String: Any]) -> Never {
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data ?? Data("{}".utf8))
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

// MARK: - The banner

/// A floating strip that never takes focus.
///
/// Non-activating and `.statusBar` level so it sits over full-screen apps and
/// cannot steal a keystroke the agent is in the middle of sending; it joins
/// every Space so switching desktops does not hide the fact that something is
/// driving the machine.
final class BannerWindow: NSPanel {
    private let label = NSTextField(labelWithString: "")
    private let pauseButton = NSButton()

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 44),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false

        let container = NSVisualEffectView(frame: contentRect(forFrameRect: frame))
        container.material = .hudWindow
        container.blendingMode = .behindWindow
        container.state = .active
        container.wantsLayer = true
        container.layer?.cornerRadius = 10
        container.autoresizingMask = [.width, .height]

        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 14, y: 12, width: 330, height: 20)
        label.autoresizingMask = [.width]

        pauseButton.title = "Pause"
        pauseButton.bezelStyle = .rounded
        pauseButton.frame = NSRect(x: 352, y: 8, width: 70, height: 28)
        pauseButton.target = self
        pauseButton.action = #selector(togglePause)
        pauseButton.autoresizingMask = [.minXMargin]

        let stopButton = NSButton(title: "Stop", target: self, action: #selector(stopAll))
        stopButton.bezelStyle = .rounded
        stopButton.frame = NSRect(x: 430, y: 8, width: 70, height: 28)
        stopButton.contentTintColor = .systemRed
        stopButton.autoresizingMask = [.minXMargin]

        container.addSubview(label)
        container.addSubview(pauseButton)
        container.addSubview(stopButton)
        contentView = container
        place()
    }

    /// Top centre of the main screen — out of the way of most work, and the
    /// first place someone looks when the pointer starts moving on its own.
    private func place() {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        setFrameOrigin(NSPoint(x: visible.midX - frame.width / 2, y: visible.maxY - frame.height - 8))
    }

    func show(agent: String, goal: String) {
        let trimmed = goal.isEmpty ? "working on your desktop" : goal
        label.stringValue = "\(agent): \(trimmed)"
        refreshPauseTitle()
        place()
        orderFrontRegardless()
    }

    func refreshPauseTitle() {
        let paused = FileManager.default.fileExists(atPath: pauseURL.path)
        pauseButton.title = paused ? "Resume" : "Pause"
        label.alphaValue = paused ? 0.6 : 1.0
    }

    @objc private func togglePause() {
        if FileManager.default.fileExists(atPath: pauseURL.path) {
            try? FileManager.default.removeItem(at: pauseURL)
        } else {
            FileManager.default.createFile(atPath: pauseURL.path, contents: Data("owner\n".utf8))
        }
        refreshPauseTitle()
    }

    @objc private func stopAll() {
        // Stop, not pause: the rails refuse every action while this exists,
        // and only the owner removing it lets anything run again.
        FileManager.default.createFile(atPath: stopURL.path, contents: Data("banner\n".utf8))
        NSApp.terminate(nil)
    }
}

// MARK: - The eye
//
// A listen-only tap. The discriminator is the event's source state: real
// input carries the HID system state, while an event posted by the agent
// (CGEventCreateMouseEvent with a null source) does not. Without that check
// the agent would pause itself on its own first click.

let HID_SOURCE_STATE: Int64 = Int64(CGEventSourceStateID.hidSystemState.rawValue)

final class UserInputWatcher {
    private var tap: CFMachPort?
    private let onUserInput: () -> Void

    init(onUserInput: @escaping () -> Void) {
        self.onUserInput = onUserInput
    }

    func start() {
        let mask =
            (1 << CGEventType.mouseMoved.rawValue) |
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.scrollWheel.rawValue)

        let callback: CGEventTapCallBack = { _, _, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let watcher = Unmanaged<UserInputWatcher>.fromOpaque(refcon).takeUnretainedValue()
            let source = event.getIntegerValueField(.eventSourceStateID)
            if source == HID_SOURCE_STATE {
                watcher.onUserInput()
            }
            // Listen only: never swallow the owner's input.
            return Unmanaged.passUnretained(event)
        }

        tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )
        guard let tap else { return }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }
}

// MARK: - Application

final class PresenceApp: NSObject, NSApplicationDelegate {
    private var banner: BannerWindow?
    private var hotkeyMonitor: Any?
    private var watcher: UserInputWatcher?
    /// Ignore our own noise: the agent moving the mouse is not the owner.
    private var lastUserInput: TimeInterval = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = BannerWindow()
        banner = window
        if let presence = readPresence() {
            window.show(agent: presence.agent, goal: presence.goal)
        }

        // ⌃⌥⌘. from anywhere. A global monitor needs accessibility, which
        // desktop control already requires, so this costs no extra prompt.
        hotkeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            let wanted: NSEvent.ModifierFlags = [.control, .option, .command]
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == wanted,
                  event.charactersIgnoringModifiers == "." else { return }
            FileManager.default.createFile(atPath: stopURL.path, contents: Data("hotkey\n".utf8))
            NSApp.terminate(nil)
        }

        watcher = UserInputWatcher { [weak self] in self?.userTouchedTheMachine() }
        watcher?.start()

        // Poll rather than watch the file: the shell writes it with a plain
        // redirect, and a rename-based watcher would miss that.
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    /// The owner reached for the mouse. Pause immediately and say so.
    private func userTouchedTheMachine() {
        let now = Date().timeIntervalSince1970
        // One pause per burst; a moving mouse fires hundreds of events.
        guard now - lastUserInput > 2 else { return }
        lastUserInput = now
        guard !FileManager.default.fileExists(atPath: pauseURL.path) else { return }
        FileManager.default.createFile(atPath: pauseURL.path, contents: Data("user-input\n".utf8))
        DispatchQueue.main.async { [weak self] in self?.banner?.refreshPauseTitle() }
    }

    private func tick() {
        guard let banner else { return }
        banner.refreshPauseTitle()

        if FileManager.default.fileExists(atPath: stopURL.path) {
            NSApp.terminate(nil)
            return
        }
        guard let presence = readPresence() else {
            NSApp.terminate(nil)
            return
        }
        banner.show(agent: presence.agent, goal: presence.goal)
        if Date().timeIntervalSince1970 - presence.updatedAt > IDLE_EXIT_SECONDS {
            // The agent stopped refreshing — it finished, or it died. Either
            // way the banner must not keep claiming work is in progress.
            try? FileManager.default.removeItem(at: stateURL)
            NSApp.terminate(nil)
        }
    }
}

// MARK: - Entry

var args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "status"
args = Array(args.dropFirst())

func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

switch command {
case "begin":
    writePresence(Presence(
        agent: option("--agent") ?? "An agent",
        goal: option("--goal") ?? "",
        updatedAt: Date().timeIntervalSince1970
    ))
    if args.contains("--foreground") {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)   // no Dock icon, no menu bar
        let delegate = PresenceApp()
        app.delegate = delegate
        app.run()
    }
    emit(["success": true, "action": "begin"])

case "end":
    try? FileManager.default.removeItem(at: stateURL)
    try? FileManager.default.removeItem(at: pauseURL)
    emit(["success": true, "action": "end"])

case "status":
    let presence = readPresence()
    emit([
        "success": true,
        "showing": presence != nil,
        "agent": presence?.agent ?? "",
        "goal": presence?.goal ?? "",
        "paused": FileManager.default.fileExists(atPath: pauseURL.path),
        "stopped": FileManager.default.fileExists(atPath: stopURL.path),
    ])

default:
    emit(["success": false, "reason": "usage", "message": "Use begin, end or status."])
}
