const { AndroidConfig, withAndroidManifest } = require("expo/config-plugins");

/** Lets MainActivity shrink into a Picture-in-Picture window during navigation. */
module.exports = function withNavigationPip(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(
      cfg.modResults,
    );
    activity.$["android:supportsPictureInPicture"] = "true";
    activity.$["android:resizeableActivity"] = "true";

    const required = [
      "screenSize",
      "smallestScreenSize",
      "screenLayout",
      "orientation",
    ];
    const current = (activity.$["android:configChanges"] || "")
      .split("|")
      .filter(Boolean);
    for (const change of required) {
      if (!current.includes(change)) current.push(change);
    }
    activity.$["android:configChanges"] = current.join("|");
    return cfg;
  });
};
