//! The bits of macOS appearance the web view can't see for itself: the
//! system accent colour, Reduce Transparency and Increase Contrast.

use serde::Serialize;

#[derive(Serialize)]
pub struct Appearance {
    /// System Settings › Appearance › Accent colour: -1 graphite, 0 red,
    /// 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 pink; None = Multicolour.
    accent: Option<i64>,
    reduce_transparency: bool,
    increase_contrast: bool,
}

#[tauri::command]
pub fn appearance() -> Appearance {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{ns_string, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        let key = ns_string!("AppleAccentColor");
        let accent = defaults.objectForKey(key).map(|_| defaults.integerForKey(key) as i64);
        let ws = NSWorkspace::sharedWorkspace();
        Appearance {
            accent,
            reduce_transparency: ws.accessibilityDisplayShouldReduceTransparency(),
            increase_contrast: ws.accessibilityDisplayShouldIncreaseContrast(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    Appearance { accent: None, reduce_transparency: false, increase_contrast: false }
}
