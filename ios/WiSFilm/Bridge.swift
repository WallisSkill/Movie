import Foundation
import WebKit

/* What the page cannot do for itself.
 *
 * The page talks to WiSNative and nothing else — the same interface the Android
 * shell puts up, so renderer/bridge-android.js and renderer/guest-android.js are
 * shared between the two platforms without a line of difference. WebKit has no
 * synchronous bridge, so the shim below turns each call into one message, and the
 * answer travels back the way it does on Android: as a reply against the ticket
 * the page sent.
 */
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private weak var shell: ShellViewController?
    private let session: URLSession

    init(shell: ShellViewController) {
        self.shell = shell
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
        super.init()
    }

    /* --------------------------------------------------------------- the shim */

    /* Written against the same names the Android interface exposes. Nothing here
       decides anything: every call is passed straight through. */
    static let nativeShim = """
    (() => {
      const send = (name, args) => window.webkit.messageHandlers.wis.postMessage({ name, args });
      window.WiSNative = {
        fetchText: (id, url, headers, timeout) => send('fetchText', [id, url, headers, timeout]),
        playerMount: (url) => send('playerMount', [url]),
        playerDrop: () => send('playerDrop', []),
        playerRect: (l, t, w, h) => send('playerRect', [l, t, w, h]),
        playerEval: (id, code) => send('playerEval', [id, code]),
        playerCss: (css) => send('playerCss', [css]),
        fullscreen: (on) => send('fullscreen', [!!on]),
        notice: (json) => send('notice', [json]),
        hh3dHost: (origin) => send('hh3dHost', [origin]),
      };
    })()
    """

    static func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
        guard let data = data, let wrapped = String(data: data, encoding: .utf8) else { return "\"\"" }
        // ["…"] with the brackets taken off is the string, escaped as JSON escapes it.
        return String(wrapped.dropFirst().dropLast())
    }

    /* Where HH3D lives moves about, so the page passes the address on once it has
       resolved it; the request filter needs it to tell the watch page's own weight
       apart from the stream. */
    private(set) var hh3dHost = ""

    /* ------------------------------------------------------------- messages */

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let name = body["name"] as? String,
              let args = body["args"] as? [Any] else { return }

        switch name {
        case "fetchText":
            guard let id = intOf(args, 0), let url = args.count > 1 ? args[1] as? String : nil else { return }
            let headers = args.count > 2 ? (args[2] as? String ?? "{}") : "{}"
            let timeout = args.count > 3 ? (doubleOf(args, 3) ?? 25000) : 25000
            fetchText(id: id, url: url, headersJson: headers, timeout: timeout / 1000)

        case "playerMount":
            if let url = args.first as? String { onMain { self.shell?.mountGuest(url: url) } }

        case "playerDrop":
            onMain { self.shell?.dropGuest() }

        case "playerRect":
            let numbers = (0..<4).map { doubleOf(args, $0) ?? 0 }
            onMain {
                self.shell?.placeGuest(
                    left: CGFloat(numbers[0]), top: CGFloat(numbers[1]),
                    width: CGFloat(numbers[2]), height: CGFloat(numbers[3])
                )
            }

        case "playerEval":
            guard let id = intOf(args, 0), let code = args.count > 1 ? args[1] as? String : nil else { return }
            onMain {
                self.shell?.evaluateInGuest(code) { value, error in
                    if let error = error {
                        self.reply(id, ["error": error.localizedDescription])
                    } else {
                        self.reply(id, ["value": value ?? NSNull()])
                    }
                }
            }

        case "playerCss":
            if let css = args.first as? String { onMain { self.shell?.styleGuest(css) } }

        case "fullscreen":
            let on = (args.first as? Bool) ?? (intOf(args, 0) == 1)
            onMain { self.shell?.goFullscreen(on) }

        case "notice":
            let json = (args.first as? String) ?? "{}"
            let parsed = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
            let text = parsed["text"] as? String ?? ""
            let labels = parsed["actions"] as? [String] ?? []
            onMain { self.shell?.showNotice(text: text, labels: labels) }

        case "hh3dHost":
            if let origin = args.first as? String, let url = URL(string: origin), let host = url.host {
                hh3dHost = host
            }

        default:
            break
        }
    }

    /* ------------------------------------------------------------- requests */

    /* The catalogue is read here rather than by fetch() because neither vsmov nor
       HH3D answers a cross-origin caller — and because the address a redirect
       finally lands on is what tells the app where HH3D lives today. */
    private func fetchText(id: Int, url: String, headersJson: String, timeout: Double) {
        guard let target = URL(string: url) else {
            reply(id, ["error": "bad url"])
            return
        }

        var request = URLRequest(url: target, timeoutInterval: timeout)
        request.httpMethod = "GET"
        if let headers = (try? JSONSerialization.jsonObject(with: Data(headersJson.utf8))) as? [String: String] {
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        }

        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            if let error = error {
                self.reply(id, ["error": error.localizedDescription])
                return
            }
            let http = response as? HTTPURLResponse
            self.reply(id, [
                "status": http?.statusCode ?? 0,
                "body": String(data: data ?? Data(), encoding: .utf8) ?? "",
                // Where it landed, not where it was asked for.
                "url": http?.url?.absoluteString ?? url,
            ])
        }.resume()
    }

    private func reply(_ id: Int, _ answer: [String: Any]) {
        let data = (try? JSONSerialization.data(withJSONObject: answer, options: [])) ?? Data("{}".utf8)
        let json = String(data: data, encoding: .utf8) ?? "{}"
        onMain { self.shell?.tellPage("window.__wisReply(\(id), \(Bridge.jsString(json)))") }
    }

    /* ---------------------------------------------------------- the guest */

    /* A watch page is a whole ad-funded site around one video, and none of it is
       ever seen — the player is pinned over the page. Blocking it by address is
       what the desktop build does in its session; here the same list is applied to
       navigation, which is as far as WebKit lets a shell reach without a content
       rule list. */
    private static let junk = try? NSRegularExpression(
        pattern: "(doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices|"
            + "adservice\\.|pagead|adsbygoogle|taboola|outbrain|mgid\\.|propeller|popads|popcash|"
            + "adsterra|onclickads|histats|statcounter|criteo|adnxs|pubmatic|rubiconproject|"
            + "casalemedia|openx\\.|smartadserver|admicro|adtima|eclick\\.|yandex|metrika|hotjar|"
            + "clarity\\.ms|disqus|gravatar|connect\\.facebook|facebook\\.net|fbcdn)",
        options: [.caseInsensitive]
    )

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url?.absoluteString ?? ""
        let range = NSRange(url.startIndex..., in: url)
        if let junk = Bridge.junk, junk.firstMatch(in: url, options: [], range: range) != nil {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Only the player's own loads are events the page is waiting for; the
        // interface finishing loading is not one of them.
        guard let shell = shell, shell.isGuest(webView) else { return }
        shell.tellPage("window.__wisGuestEvent && window.__wisGuestEvent('dom-ready', '{}')")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard let shell = shell, shell.isGuest(webView) else { return }
        shell.tellPage("window.__wisGuestEvent && window.__wisGuestEvent('did-fail-load', '{\"isMainFrame\":true}')")
    }

    /* ------------------------------------------------------------- helpers */

    private func intOf(_ args: [Any], _ index: Int) -> Int? {
        guard args.count > index else { return nil }
        if let value = args[index] as? Int { return value }
        if let value = args[index] as? Double { return Int(value) }
        if let value = args[index] as? NSNumber { return value.intValue }
        return nil
    }

    private func doubleOf(_ args: [Any], _ index: Int) -> Double? {
        guard args.count > index else { return nil }
        if let value = args[index] as? Double { return value }
        if let value = args[index] as? Int { return Double(value) }
        if let value = args[index] as? NSNumber { return value.doubleValue }
        return nil
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }
}
