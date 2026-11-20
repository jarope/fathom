# Homebrew cask for Fathom. Lives in the tap repo github.com/jarope/homebrew-fathom
# as Casks/fathom.rb, so people can:   brew install jarope/fathom/fathom
# After each release, set version and sha256 (release.sh prints both).
cask "fathom" do
  version "0.27.0"
  sha256 "REPLACE_WITH_DMG_SHA256"

  url "https://github.com/jarope/fathom/releases/download/v#{version}/Fathom_#{version}_universal.dmg"
  name "Fathom"
  desc "Twin-pane file manager with Dolphin's features and Spotlight search"
  homepage "https://github.com/jarope/fathom"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :big_sur"

  app "Fathom.app"

  # Fathom isn't notarised yet (no Apple Developer ID), so let macOS open it
  # without the "can't check it for malicious software" block.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/Fathom.app"]
  end

  zap trash: [
    "~/.config/fathom",
    "~/Library/Application Support/uk.jrpc.fathom",
    "~/Library/Caches/fathom",
    "~/Library/Caches/uk.jrpc.fathom",
    "~/Library/Saved Application State/uk.jrpc.fathom.savedState",
    "~/Library/WebKit/fathom",
    "~/Library/WebKit/uk.jrpc.fathom",
  ]
end
