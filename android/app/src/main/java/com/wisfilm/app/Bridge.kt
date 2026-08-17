package com.wisfilm.app

import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/* What the page cannot do for itself.
 *
 * Every method here is called from the WebView's own thread, so anything that
 * touches a view is posted back to the main one, and every answer travels the
 * same way it would in Electron: as a reply against the ticket the page sent. */
class Bridge(private val activity: MainActivity) {

    private val pool = Executors.newFixedThreadPool(6)

    private fun reply(id: Int, body: String) {
        activity.runOnUiThread {
            activity.host.evaluateJavascript("window.__wisReply($id, ${JSONObject.quote(body)})", null)
        }
    }

    /* ------------------------------------------------------------- requests */

    /* The catalogue is read here rather than by fetch() because neither vsmov
     * nor HH3D answers a cross-origin caller — and because the address a
     * redirect finally lands on is what tells the app where HH3D lives today. */
    @JavascriptInterface
    fun fetchText(id: Int, url: String, headersJson: String, timeout: Int) {
        pool.execute {
            try {
                val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = timeout
                    readTimeout = timeout
                    instanceFollowRedirects = true
                    requestMethod = "GET"
                }

                val headers = JSONObject(headersJson)
                headers.keys().forEach { key ->
                    connection.setRequestProperty(key, headers.optString(key))
                }

                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val body = stream?.let {
                    InputStreamReader(it, Charsets.UTF_8).use { reader -> reader.readText() }
                } ?: ""

                val answer = JSONObject()
                answer.put("status", status)
                answer.put("body", body)
                answer.put("url", connection.url.toString())
                connection.disconnect()
                reply(id, answer.toString())
            } catch (err: Throwable) {
                reply(id, JSONObject().put("error", err.message ?: err.toString()).toString())
            }
        }
    }

    /* --------------------------------------------------------------- player */

    @JavascriptInterface
    fun playerMount(url: String) {
        activity.runOnUiThread { activity.mountGuest(url) }
    }

    @JavascriptInterface
    fun playerDrop() {
        activity.runOnUiThread { activity.dropGuest() }
    }

    @JavascriptInterface
    fun playerRect(left: Float, top: Float, width: Float, height: Float) {
        activity.runOnUiThread { activity.placeGuest(left, top, width, height) }
    }

    @JavascriptInterface
    fun playerEval(id: Int, code: String) {
        activity.runOnUiThread {
            val guest = activity.guest
            if (guest == null) {
                reply(id, JSONObject().put("error", "player not mounted").toString())
                return@runOnUiThread
            }
            // evaluateJavascript hands back the result already encoded as JSON,
            // which is exactly what the page is waiting for.
            guest.evaluateJavascript(code) { value ->
                reply(id, "{\"value\":${if (value.isNullOrEmpty()) "null" else value}}")
            }
        }
    }

    @JavascriptInterface
    fun playerCss(css: String) {
        activity.runOnUiThread {
            val guest = activity.guest ?: return@runOnUiThread
            val literal = JSONObject.quote(css)
            guest.evaluateJavascript(
                "(() => { const s = document.createElement('style'); s.textContent = $literal; " +
                    "(document.head || document.documentElement).appendChild(s); return true; })()",
                null
            )
        }
    }

    /* Full screen on a handset means sideways with nothing else on the screen.
     * Neither the orientation nor the system bars are a page's to decide, so the
     * page asks and this does it. */
    @JavascriptInterface
    fun fullscreen(on: Boolean) {
        activity.runOnUiThread { activity.goFullscreen(on) }
    }

    @JavascriptInterface
    fun notice(json: String) {
        val parsed = try {
            JSONObject(json)
        } catch (err: Throwable) {
            JSONObject()
        }
        val text = parsed.optString("text")
        val actions = parsed.optJSONArray("actions") ?: JSONArray()
        val labels = (0 until actions.length()).map { actions.optString(it) }
        activity.runOnUiThread { activity.showNotice(text, labels) }
    }

    /* ----------------------------------------------------------- app's own data */

    /* Favourites, history, where a film was left off, subtitles added — the app's
     * own data, kept by the app rather than by the web view. A web view's storage
     * is tied to the origin its page came from and is not a promise; this is. */
    @JavascriptInterface
    fun storeRead(): String = activity.readStore()

    @JavascriptInterface
    fun storeWrite(json: String) {
        activity.writeStore(json)
    }

    /* The chooser for a subtitle. Opened here rather than by the page, because a
     * chooser built from an accept list lands in photos and video — and there is no
     * system type for a .srt at all, so nothing in it could be picked. */
    @JavascriptInterface
    fun pickSubtitle() {
        activity.runOnUiThread { activity.pickSubtitle() }
    }

    /* Where HH3D lives moves about, so the page passes the address on once it
     * has resolved it; the request filter needs it to tell the watch page's own
     * weight apart from the stream. */
    @JavascriptInterface
    fun hh3dHost(origin: String) {
        hh3dHostName = try {
            URL(origin).host
        } catch (err: Throwable) {
            ""
        }
    }

    companion object {
        @Volatile
        var hh3dHostName: String = ""
    }
}

/* The UI, served to itself.
 *
 * Assets read over file:// are a second-class origin: storage is unreliable and
 * the page's own Content-Security-Policy stops recognising its own scripts. The
 * loader answers an https address the app owns with the very same files, so the
 * UI runs under the rules it was written against on the desktop. */
class HostClient(activity: MainActivity) : WebViewClient() {

    private val assets: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(MainActivity.UI_HOST)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(activity))
        .build()

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? = request?.url?.let { assets.shouldInterceptRequest(it) }

    /* The interface itself never navigates away: a link that escaped it would
     * strand the app on a page with no way back. A frame inside it is another
     * matter — that is how a trailer is embedded — so only the main frame is held
     * to the rule. */
    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        if (request?.isForMainFrame != true) return false
        return request.url?.host != MainActivity.UI_HOST
    }
}

/* A watch page is a whole ad-funded site around one video: trackers, ad frames,
 * avatars, sliders. All of it competes with the stream for bandwidth and for the
 * frames the player has to decode on time, which is what stuttering looks like.
 * None of it is ever seen — the player is pinned over the page — so none of it is
 * worth fetching. */
class GuestClient(private val activity: MainActivity) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null
        if (JUNK.containsMatchIn(url)) return BLOCKED()

        val host = Bridge.hh3dHostName
        if (host.isNotEmpty() && (request.url.host ?: "").endsWith(host) && isDeadWeight(request, url)) {
            return BLOCKED()
        }
        return null
    }

    // Android does not say what a request is for, so it is read off what the
    // caller says it will take and, failing that, off the name.
    private fun isDeadWeight(request: WebResourceRequest, url: String): Boolean {
        val accept = request.requestHeaders["Accept"] ?: request.requestHeaders["accept"] ?: ""
        if (accept.startsWith("image/") || accept.contains("font")) return true
        val path = url.substringBefore('?').lowercase()
        return ASSET_SUFFIX.any { path.endsWith(it) }
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        // The page is up: this is the moment the desktop build calls dom-ready,
        // and everything the app injects hangs off it.
        activity.host.evaluateJavascript("window.__wisGuestEvent && window.__wisGuestEvent('dom-ready', '{}')", null)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: android.webkit.WebResourceError?
    ) {
        if (request?.isForMainFrame != true) return
        val detail = JSONObject()
            .put("isMainFrame", true)
            .put("errorCode", error?.errorCode ?: -1)
            .toString()
        activity.host.evaluateJavascript(
            "window.__wisGuestEvent && window.__wisGuestEvent('did-fail-load', ${JSONObject.quote(detail)})",
            null
        )
    }

    override fun onRenderProcessGone(
        view: WebView?,
        detail: android.webkit.RenderProcessGoneDetail?
    ): Boolean {
        activity.host.evaluateJavascript(
            "window.__wisGuestEvent && window.__wisGuestEvent('render-process-gone', '{}')",
            null
        )
        // Saying yes is what keeps the app alive when the player's process dies.
        activity.runOnUiThread { activity.dropGuest() }
        return true
    }

    private companion object {
        val JUNK = Regex(
            "(doubleclick|googlesyndication|googletagmanager|google-analytics|googleadservices|" +
                "adservice\\.|pagead|adsbygoogle|taboola|outbrain|mgid\\.|propeller|popads|popcash|" +
                "adsterra|onclickads|histats|statcounter|criteo|adnxs|pubmatic|rubiconproject|" +
                "casalemedia|openx\\.|smartadserver|admicro|adtima|eclick\\.|yandex|metrika|hotjar|" +
                "clarity\\.ms|disqus|gravatar|connect\\.facebook|facebook\\.net|fbcdn)",
            RegexOption.IGNORE_CASE
        )

        val ASSET_SUFFIX = listOf(
            ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".ico",
            ".woff", ".woff2", ".ttf", ".otf", ".eot"
        )

        fun BLOCKED() = WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }
}
