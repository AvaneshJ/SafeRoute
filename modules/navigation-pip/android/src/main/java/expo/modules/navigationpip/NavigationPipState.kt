package expo.modules.navigationpip

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.os.Build
import android.util.Rational
import androidx.annotation.RequiresApi

/** Shared between the JS module and the activity lifecycle listener. */
internal object NavigationPipState {
  @Volatile
  var enabled = false

  @Volatile
  var aspectRatio = Rational(3, 4)

  // Android rejects ratios outside 1:2.39 .. 2.39:1.
  fun setAspect(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    val ratio = width.toFloat() / height
    aspectRatio = when {
      ratio < 1f / 2.39f -> Rational(100, 239)
      ratio > 2.39f -> Rational(239, 100)
      else -> Rational(width, height)
    }
  }

  fun isSupported(activity: Activity): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  fun isInPictureInPicture(activity: Activity?): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
      activity?.isInPictureInPictureMode == true

  @RequiresApi(Build.VERSION_CODES.O)
  private fun buildParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(aspectRatio)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(enabled)
      // A map is not video; cross-fade instead of stretching frames while resizing.
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  /** Must run on the UI thread. */
  fun applyParams(activity: Activity) {
    if (!isSupported(activity)) return
    try {
      activity.setPictureInPictureParams(buildParams())
    } catch (_: IllegalStateException) {
      // Activity not declared with supportsPictureInPicture.
    }
  }

  /** Must run on the UI thread. */
  fun enter(activity: Activity): Boolean {
    if (!isSupported(activity) || activity.isFinishing) return false
    return try {
      activity.enterPictureInPictureMode(buildParams())
    } catch (_: IllegalStateException) {
      false
    }
  }
}
