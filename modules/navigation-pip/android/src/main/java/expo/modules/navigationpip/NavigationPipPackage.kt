package expo.modules.navigationpip

import android.app.Activity
import android.content.Context
import android.os.Build
import expo.modules.core.BasePackage
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class NavigationPipPackage : BasePackage() {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context
  ): List<ReactActivityLifecycleListener> = listOf(NavigationPipLifecycleListener())
}

/** Android 12+ auto-enters via setAutoEnterEnabled; Android 8–11 must enter on leave. */
private class NavigationPipLifecycleListener : ReactActivityLifecycleListener {
  override fun onUserLeaveHint(activity: Activity) {
    if (!NavigationPipState.enabled) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S
    ) {
      NavigationPipState.enter(activity)
    }
  }
}
