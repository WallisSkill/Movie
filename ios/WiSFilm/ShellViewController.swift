import UIKit
import WebKit

/* The screen: the interface, the player over it when a film is on, and the notice
 * the page asks for when a stream drops.
 *
 * The interface is served to itself over an https origin the app owns, the same
 * trick the Android shell uses — assets read over file:// are a second-class
 * origin, where storage is unreliable and a page stops trusting its own scripts.
 */
final class ShellViewController: UIViewController {
    private static let uiHost = "appassets.wisfilm.local"
    private static let uiScheme = "wisfilm"

    private var host: WKWebView!
    private var guest: WKWebView?
    private var notice: UIStackView?
    private var bridge: Bridge!

    private let backdrop = UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)

    override func loadView() {
        view = UIView()
        view.backgroundColor = backdrop
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        bridge = Bridge(shell: self)
        host = makeWebView(playback: false, handler: bridge)
        host.navigationDelegate = bridge

        host.frame = view.bounds
        host.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host)

        if let url = URL(string: "\(Self.uiScheme)://\(Self.uiHost)/renderer/index.html") {
            host.load(URLRequest(url: url))
        }
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    /* ----------------------------------------------------------- full screen */

    /* A film full screen on a handset means sideways: upright it would be a strip
     * across the middle of the glass. While that is on, this screen accepts only
     * landscape, and iOS turns the picture to match. */
    private var lockedLandscape = false

    /* A phone is held one way for a film and the other for everything else, so this
     * screen accepts only one at a time: landscape while watching, upright once the
     * film is closed. An iPad is big enough for either and is left to its own
     * devices. */
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return .all }
        return lockedLandscape ? .landscape : .portrait
    }

    override var shouldAutorotate: Bool { true }

    func goFullscreen(_ on: Bool) {
        guard lockedLandscape != on else { return }
        lockedLandscape = on
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }

        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            let wanted: UIInterfaceOrientationMask = on ? .landscape : .portrait
            guard let scene = view.window?.windowScene else { return }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: wanted)) { _ in }
        } else {
            // The older way: tell the device which way up it now is.
            let value = on ? UIInterfaceOrientation.landscapeRight.rawValue : UIInterfaceOrientation.portrait.rawValue
            UIDevice.current.setValue(value, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    /* ------------------------------------------------------------ web views */

    private func makeWebView(playback: Bool, handler: Bridge?) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // Nothing here is ever a user gesture: playback is started by the page the
        // moment the stream is ready.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.suppressesIncrementalRendering = false

        if playback {
            // The desktop print of a watch page is the one whose player is known.
            config.applicationNameForUserAgent = "Version/17.0 Safari/605.1.15"
        } else if let handler = handler {
            let scripts = WKUserContentController()
            scripts.add(handler, name: "wis")
            // WiSNative, in the shape the page already expects — see
            // renderer/bridge-android.js, which is written against exactly this.
            scripts.addUserScript(
                WKUserScript(source: Bridge.nativeShim, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
            config.userContentController = scripts
            config.setURLSchemeHandler(AssetHandler(), forURLScheme: Self.uiScheme)
        }

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = playback ? .black : backdrop
        web.scrollView.backgroundColor = playback ? .black : backdrop
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        /* No inset of iOS's own: the page is laid out to the edges on purpose and
         * keeps its own content clear of the notch. An inset added here would shift
         * everything down, and the rect the page reports for the picture would no
         * longer be where the picture is put — which is how the way out of a film
         * ends up underneath it. */
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.insetsLayoutMarginsFromSafeArea = false
        return web
    }

    func mountGuest(url: String) {
        dropGuest()
        guard let target = URL(string: url) else { return }

        let web = makeWebView(playback: true, handler: nil)
        web.navigationDelegate = bridge
        web.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        view.addSubview(web)
        if let notice = notice { view.bringSubviewToFront(notice) }
        guest = web
        showExit()

        // A film should not be interrupted by the screen going out.
        UIApplication.shared.isIdleTimerDisabled = true
        web.load(URLRequest(url: target))
    }

    /* ---------------------------------------------------------- the way out */

    /* The page draws its own bar with a way out of a film, and here that bar is
     * HTML while the picture is a view laid over it: place the picture even
     * slightly wrong and the way out sits underneath it, which is how a film
     * became impossible to leave. A native button cannot be covered by a native
     * view above it, and this one exists only while a film does. */
    private var exit: UIButton?

    private func showExit() {
        guard exit == nil else { return }

        let button = UIButton(type: .system)
        button.setTitle("✕", for: .normal)
        button.setTitleColor(.white, for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.backgroundColor = UIColor(white: 0, alpha: 0.6)
        button.layer.cornerRadius = 19
        button.translatesAutoresizingMaskIntoConstraints = false
        button.addTarget(self, action: #selector(exitTapped), for: .touchUpInside)

        view.addSubview(button)
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: 38),
            button.heightAnchor.constraint(equalToConstant: 38),
            button.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 10),
            button.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 10),
        ])
        exit = button
    }

    @objc private func exitTapped() {
        // The page decides what leaving means, and says so when there is nothing
        // left to leave.
        tellPage("window.__wisBack ? window.__wisBack() : false")
    }

    private func hideExit() {
        exit?.removeFromSuperview()
        exit = nil
    }

    func dropGuest() {
        hideExit()
        guest?.stopLoading()
        guest?.removeFromSuperview()
        guest = nil
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /* The page reports where its stage element landed, in CSS pixels, which on
     * this platform are the same points the view system uses. */
    func placeGuest(left: CGFloat, top: CGFloat, width: CGFloat, height: CGFloat) {
        guest?.frame = CGRect(x: left, y: top, width: max(width, 1), height: max(height, 1))
    }

    // The bridge is delegate to both web views, and only the player's own loads
    // are events the page is waiting for.
    func isGuest(_ web: WKWebView) -> Bool { web === guest }

    func evaluateInGuest(_ code: String, completion: @escaping (Any?, Error?) -> Void) {
        guard let guest = guest else {
            completion(nil, NSError(domain: "wisfilm", code: 1, userInfo: [NSLocalizedDescriptionKey: "player not mounted"]))
            return
        }
        guest.evaluateJavaScript(code, completionHandler: completion)
    }

    func styleGuest(_ css: String) {
        let literal = Bridge.jsString(css)
        let code = """
        (() => { const s = document.createElement('style'); s.textContent = \(literal);
                 (document.head || document.documentElement).appendChild(s); return true; })()
        """
        guest?.evaluateJavaScript(code, completionHandler: nil)
    }

    func tellPage(_ code: String) {
        host.evaluateJavaScript(code, completionHandler: nil)
    }

    /* -------------------------------------------------------------- notice */

    /* The stage is covered by a view of its own, so the reconnect notice cannot be
     * drawn by the page that decides on it. It is passed over instead, and the
     * buttons answer back by the order they arrived in. */
    func showNotice(text: String, labels: [String]) {
        notice?.removeFromSuperview()
        notice = nil
        guard !text.isEmpty else { return }

        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 8
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        row.backgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.13, alpha: 0.92)
        row.layer.cornerRadius = 14
        row.translatesAutoresizingMaskIntoConstraints = false

        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.numberOfLines = 2
        row.addArrangedSubview(label)

        for (index, caption) in labels.enumerated() {
            let button = UIButton(type: .system)
            button.setTitle(caption, for: .normal)
            button.setTitleColor(.white, for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
            button.tag = index
            button.addTarget(self, action: #selector(noticeTapped(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
        }

        view.addSubview(row)
        NSLayoutConstraint.activate([
            row.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            row.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            row.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.9),
        ])
        notice = row
    }

    @objc private func noticeTapped(_ sender: UIButton) {
        tellPage("window.__wisNoticeAction(\(sender.tag))")
        showNotice(text: "", labels: [])
    }
}

/* The interface, served to itself. A custom scheme gives it a real origin, which
 * is what makes storage and its own Content-Security-Policy behave as they do on
 * the desktop. */
final class AssetHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url,
              let root = Bundle.main.resourceURL?.appendingPathComponent("www") else {
            task.didFailWithError(NSError(domain: "wisfilm", code: 404))
            return
        }

        let wanted = url.path.isEmpty || url.path == "/" ? "/renderer/index.html" : url.path
        // Nothing outside the bundled interface is served, whatever the path says.
        let file = root.appendingPathComponent(wanted).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: "wisfilm", code: 404))
            return
        }

        let types = [
            "html": "text/html; charset=utf-8",
            "js": "text/javascript; charset=utf-8",
            "css": "text/css; charset=utf-8",
            "svg": "image/svg+xml",
            "png": "image/png",
            "jpg": "image/jpeg",
            "json": "application/json",
        ]
        let type = types[file.pathExtension.lowercased()] ?? "application/octet-stream"

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": type, "Cache-Control": "no-store"]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
