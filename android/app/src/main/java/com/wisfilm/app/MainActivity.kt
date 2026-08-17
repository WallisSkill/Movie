package com.wisfilm.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ActivityInfo
import android.os.Build
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/* WiSFilm on Android.
 *
 * The whole app is the desktop UI, loaded out of the assets into a WebView. Two
 * things that WebView cannot do for itself are done here instead: requests go
 * out through the shell, because the sites this reads answer no cross-origin
 * caller, and the player is a second WebView laid over the first, because a
 * page cannot host another browsing context it is allowed to script.
 *
 * Everything below is driven from the page through Bridge; this class only owns
 * the views and the keys. */
class MainActivity : Activity() {

    private lateinit var root: FrameLayout
    lateinit var host: WebView
        private set

    var guest: WebView? = null
        private set

    private var notice: LinearLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = FrameLayout(this)
        root.setBackgroundColor(BACKDROP)
        setContentView(root)

        host = buildWebView(playbackView = false)
        host.addJavascriptInterface(Bridge(this), "WiSNative")
        host.webViewClient = HostClient(this)
        root.addView(
            host,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        host.loadUrl(UI_URL)
    }

    /* ------------------------------------------------------------- webviews */

    @SuppressLint("SetJavaScriptEnabled")
    fun buildWebView(playbackView: Boolean): WebView {
        val view = WebView(this)
        view.setBackgroundColor(if (playbackView) Color.BLACK else BACKDROP)

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            // Nothing here is ever a user gesture: playback is started by the
            // page the moment the stream is ready.
            mediaPlaybackRequiresUserGesture = false
            // Every popup on an ad-funded watch page is an advert.
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            if (playbackView) {
                // The desktop print of the watch page is the one whose player we
                // know how to pin.
                userAgentString = DESKTOP_UA
                useWideViewPort = true
                loadWithOverviewMode = true
            } else {
                allowFileAccess = true
                allowContentAccess = false
            }
        }

        return view
    }

    fun mountGuest(url: String) {
        dropGuest()

        val view = buildWebView(playbackView = true)
        view.webViewClient = GuestClient(this)
        view.layoutParams = FrameLayout.LayoutParams(1, 1)
        guest = view
        root.addView(view)
        notice?.let { root.bringChildToFront(it) }

        // A film should not be interrupted by the screen going out.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        view.loadUrl(url)
    }

    fun dropGuest() {
        guest?.let { view ->
            root.removeView(view)
            view.stopLoading()
            view.loadUrl("about:blank")
            view.destroy()
        }
        guest = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /* The page reports where its stage element landed, in CSS pixels; the view
     * has to be placed in real ones. */
    fun placeGuest(left: Float, top: Float, width: Float, height: Float) {
        val view = guest ?: return
        val d = resources.displayMetrics.density
        val params = FrameLayout.LayoutParams(
            (width * d).toInt().coerceAtLeast(1),
            (height * d).toInt().coerceAtLeast(1)
        )
        params.leftMargin = (left * d).toInt()
        params.topMargin = (top * d).toInt()
        view.layoutParams = params
        view.requestLayout()
    }

    /* ----------------------------------------------------------- full screen */

    /* Sideways, and with the system bars out of the way. A television is already
     * landscape and has no bars to hide, so it is left alone — the request only
     * makes sense on something held in the hand. */
    fun goFullscreen(on: Boolean) {
        val leanback = packageManager.hasSystemFeature("android.software.leanback")

        if (!leanback) {
            /* Coming out goes back to upright rather than to whatever the handset
               happens to be held at: the app is a column of lists and a detail page
               read top to bottom, and a film is the only part of it that is not. */
            requestedOrientation =
                if (on) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val controller = window.insetsController
            if (on) {
                controller?.hide(WindowInsets.Type.systemBars())
                controller?.systemBarsBehavior =
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller?.show(WindowInsets.Type.systemBars())
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility =
                if (on) {
                    View.SYSTEM_UI_FLAG_FULLSCREEN or
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                } else {
                    View.SYSTEM_UI_FLAG_VISIBLE
                }
        }
    }

    /* --------------------------------------------------------------- notice */

    /* The stage is covered by a native view, so the reconnect notice cannot be
     * drawn by the page that decides on it. It is passed over instead, and the
     * buttons answer back by the order they arrived in — which is also what
     * makes them reachable with a remote, since they are real focusable views. */
    fun showNotice(text: String, labels: List<String>) {
        notice?.let { root.removeView(it) }
        notice = null
        if (text.isEmpty()) return

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setBackgroundColor(NOTICE_BG)
        val pad = dp(10)
        row.setPadding(pad, pad, pad, pad)

        val label = TextView(this)
        label.text = text
        label.setTextColor(Color.WHITE)
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        row.addView(
            label,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        )

        labels.forEachIndexed { index, caption ->
            val button = Button(this)
            button.text = caption
            button.isFocusable = true
            button.isFocusableInTouchMode = false
            button.setOnClickListener {
                host.evaluateJavascript("window.__wisNoticeAction($index)", null)
                showNotice("", emptyList())
            }
            row.addView(button)
        }

        val params = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        )
        params.gravity = Gravity.TOP
        params.topMargin = dp(12)
        root.addView(row, params)
        notice = row
        row.requestFocus()
    }

    /* ------------------------------------------------------------------ keys */

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            // The page knows what it is showing, so it decides what Back means;
            // only when it says there is nothing left does the app close.
            host.evaluateJavascript("window.__wisBack ? window.__wisBack() : false") { answer ->
                if (answer != "true") finish()
            }
            return true
        }

        // While a film is up the remote is the film's, not the layout's.
        val guestView = guest
        if (guestView != null && guestView.visibility == View.VISIBLE) {
            val jump = when (keyCode) {
                KeyEvent.KEYCODE_MEDIA_REWIND -> -10
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> 10
                else -> 0
            }
            if (jump != 0) {
                guestView.evaluateJavascript(seekScript(jump), null)
                return true
            }
            if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
                keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
                keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE
            ) {
                guestView.evaluateJavascript(TOGGLE_SCRIPT, null)
                return true
            }
        }

        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        dropGuest()
        host.destroy()
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val BACKDROP = 0xFF0B0D12.toInt()
        private const val NOTICE_BG = 0xE6141821.toInt()

        // The UI is served to itself over an origin the app owns — see HostClient.
        const val UI_HOST = "appassets.androidplatform.net"
        const val UI_URL = "https://$UI_HOST/assets/www/renderer/index.html"

        const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
                "Chrome/126.0.0.0 Safari/537.36"

        private const val TOGGLE_SCRIPT =
            "(() => { const v = document.querySelector('video'); if (!v) return false; " +
                "v.paused ? v.play() : v.pause(); return true; })()"

        private fun seekScript(jump: Int) =
            "(() => { const v = document.querySelector('video'); if (!v) return false; " +
                "v.currentTime = Math.max(0, v.currentTime + ($jump)); return true; })()"
    }
}
