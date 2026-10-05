package expo.modules.navigationpip

import android.app.Activity
import androidx.core.app.OnPictureInPictureModeChangedProvider
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

private const val PIP_MODE_CHANGED = "onPictureInPictureModeChanged"

class NavigationPipModule : Module() {
  private var observed: WeakReference<OnPictureInPictureModeChangedProvider>? = null

  private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
    sendEvent(
      PIP_MODE_CHANGED,
      mapOf("isInPictureInPicture" to info.isInPictureInPictureMode)
    )
  }

  private fun observe(activity: Activity) {
    val provider = activity as? OnPictureInPictureModeChangedProvider ?: return
    if (observed?.get() === provider) return
    observed?.get()?.removeOnPictureInPictureModeChangedListener(pipListener)
    provider.addOnPictureInPictureModeChangedListener(pipListener)
    observed = WeakReference(provider)
  }

  private fun onUi(block: (Activity) -> Unit): Boolean {
    val activity = appContext.currentActivity ?: return false
    activity.runOnUiThread { block(activity) }
    return true
  }

  override fun definition() = ModuleDefinition {
    Name("NavigationPip")

    Events(PIP_MODE_CHANGED)

    Function("isSupported") {
      appContext.currentActivity?.let { NavigationPipState.isSupported(it) } ?: false
    }

    Function("isInPictureInPicture") {
      NavigationPipState.isInPictureInPicture(appContext.currentActivity)
    }

    AsyncFunction("setEnabled") { enabled: Boolean, aspectWidth: Int, aspectHeight: Int ->
      NavigationPipState.enabled = enabled
      NavigationPipState.setAspect(aspectWidth, aspectHeight)
      onUi { activity ->
        observe(activity)
        NavigationPipState.applyParams(activity)
      }
    }

    AsyncFunction("enter") { promise: Promise ->
      val dispatched = onUi { activity ->
        observe(activity)
        promise.resolve(NavigationPipState.enter(activity))
      }
      if (!dispatched) promise.resolve(false)
    }

    OnActivityEntersForeground {
      onUi { observe(it) }
    }

    OnDestroy {
      observed?.get()?.removeOnPictureInPictureModeChangedListener(pipListener)
      observed = null
    }
  }
}
