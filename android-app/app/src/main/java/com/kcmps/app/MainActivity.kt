package com.kcmps.app

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen

/**
 * KCMPS — native WebView wrapper around https://kcmps.com.
 *
 * Key behaviors:
 *  - Popup windows (window.open) get a real second WebView presented as a
 *    full-screen overlay: the Cognito Hosted UI login/logout flow depends on
 *    this (popup navigates to the auth domain, lands back on kcmps.com, writes
 *    tokens to the shared localStorage, then calls window.close()).
 *  - URL scope: kcmps.com / www / dev + the Cognito auth domain stay in-app;
 *    everything else goes to the system (browser, mail, dialer).
 *  - File uploads (payment proofs, design files) via onShowFileChooser.
 *  - Downloads (presigned S3 GETs with Content-Disposition: attachment) via
 *    DownloadManager into the public Downloads folder.
 */
class MainActivity : ComponentActivity() {

    private val startUrl = "https://kcmps.com/"

    private val allowedHosts = setOf(
        "kcmps.com",
        "www.kcmps.com",
        "dev.kcmps.com",
        "kcmps-auth.auth.ap-southeast-1.amazoncognito.com"
    )

    private lateinit var root: FrameLayout
    private lateinit var mainWebView: WebView
    private var popupLayer: FrameLayout? = null
    private var popupWebView: WebView? = null

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback
        filePathCallback = null
        if (callback == null) return@registerForActivityResult
        val data = result.data
        if (result.resultCode != RESULT_OK || data == null) {
            // Cancelled — must still deliver null or all future choosers wedge.
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }
        val uris = mutableListOf<Uri>()
        val clip = data.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri)
        }
        if (uris.isEmpty()) data.data?.let { uris.add(it) }
        callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)

        window.statusBarColor = Color.parseColor("#0b1930")

        root = FrameLayout(this)
        mainWebView = createWebView(isPopup = false)
        root.addView(
            mainWebView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(root)

        // restoreState() can come back with an EMPTY back/forward list (state
        // saved before the first page ever committed — e.g. the system relaunching
        // the activity moments after a cold start). Without a fallback load the
        // WebView stays blank forever, so always check what was actually restored.
        val restored = savedInstanceState?.let { mainWebView.restoreState(it) }
        if (restored == null || restored.size == 0) {
            mainWebView.loadUrl(startUrl)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    popupLayer != null -> closePopup()
                    mainWebView.canGoBack() -> mainWebView.goBack()
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        mainWebView.saveState(outState)
    }

    override fun onDestroy() {
        closePopup()
        mainWebView.destroy()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- WebView

    private fun createWebView(isPopup: Boolean): WebView {
        val webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = true
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
        }
        webView.webViewClient = ScopedWebViewClient(isPopup)
        webView.webChromeClient = chromeClient
        wireDownloads(webView)
        return webView
    }

    /** Keeps the allowed hosts in-app; hands everything else to the system. */
    private inner class ScopedWebViewClient(private val isPopup: Boolean) : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url
            val scheme = uri.scheme?.lowercase()
            if (scheme == "about") return false // popups start life on about:blank
            if (scheme == "http" || scheme == "https") {
                val host = uri.host?.lowercase()
                if (host != null && host in allowedHosts) return false
            }
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this@MainActivity, "No app can open this link", Toast.LENGTH_SHORT).show()
            }
            if (isPopup) closePopup()
            return true
        }
    }

    // One WebChromeClient shared by both WebViews (popup + file chooser + close).
    private val chromeClient = object : WebChromeClient() {

        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message
        ): Boolean {
            closePopup() // one popup at a time; replace any existing one
            val popup = createWebView(isPopup = true)
            showPopupLayer(popup)
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            if (window === popupWebView) closePopup()
        }

        override fun onShowFileChooser(
            webView: WebView,
            callback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams
        ): Boolean {
            // A leaked previous callback wedges all future uploads — flush it.
            filePathCallback?.onReceiveValue(null)
            filePathCallback = callback

            val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                val mimes = fileChooserParams.acceptTypes
                    ?.filter { it.isNotBlank() && it.contains('/') } // mime types only, skip ".jpg"-style extensions
                    ?.toTypedArray()
                if (!mimes.isNullOrEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes)
                if (fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                }
            }
            return try {
                fileChooserLauncher.launch(Intent.createChooser(intent, "Choose file"))
                true
            } catch (e: ActivityNotFoundException) {
                filePathCallback = null
                Toast.makeText(this@MainActivity, "No file picker available", Toast.LENGTH_SHORT).show()
                false
            }
        }
    }

    // ---------------------------------------------------------------- popup

    private fun showPopupLayer(popup: WebView) {
        val layer = FrameLayout(this)
        layer.setBackgroundColor(Color.WHITE)

        layer.addView(
            popup,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        // Native close (X) escape hatch, top-right.
        val density = resources.displayMetrics.density
        val closeButton = TextView(this).apply {
            text = "✕"
            textSize = 18f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#CC0b1930"))
            }
            elevation = 8f * density
            setOnClickListener { closePopup() }
        }
        val size = (40 * density).toInt()
        val margin = (12 * density).toInt()
        val params = FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.END)
        params.topMargin = margin
        params.rightMargin = margin
        layer.addView(closeButton, params)

        root.addView(
            layer,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        popupLayer = layer
        popupWebView = popup
    }

    private fun closePopup() {
        val layer = popupLayer ?: return
        popupLayer = null
        val popup = popupWebView
        popupWebView = null
        root.removeView(layer)
        popup?.apply {
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
    }

    // ---------------------------------------------------------------- downloads

    private fun wireDownloads(webView: WebView) {
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                    setMimeType(mimeType)
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        URLUtil.guessFileName(url, contentDisposition, mimeType)
                    )
                }
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "Downloading…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Could not start download", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
