import UIKit

/* WiSFilm on iOS.
 *
 * The app is the same interface the desktop build carries, loaded out of the
 * bundle into a WKWebView. Two things that web view cannot do for itself are done
 * in Swift instead: requests go out through the shell, because neither site this
 * reads answers a cross-origin caller, and the player is a second web view laid
 * over the first, because a page cannot host another browsing context it is
 * allowed to script.
 *
 * That is the same division as the Android shell, and deliberately so: the page
 * only ever talks to WiSNative, and it does not care which language is behind it.
 */
@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ShellViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
