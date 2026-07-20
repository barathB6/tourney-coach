// Config plugin: inject `use_modular_headers!` into the iOS Podfile.
//
// @react-native-google-signin/google-signin pulls in Firebase's
// AppCheckCore, a Swift pod that can't be integrated as a static library
// unless modular headers are enabled. Without this the very first
// `pod install` after a prebuild fails. Doing it as a plugin (rather than a
// hand-edit) means it re-applies automatically on every `expo prebuild`.
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfile, 'utf8');
      if (!contents.includes('use_modular_headers!')) {
        // Anchor after the first use_expo_modules! inside the app target.
        contents = contents.replace(
          /(\n\s*use_expo_modules!\s*\n)/,
          '$1  use_modular_headers!\n'
        );
        fs.writeFileSync(podfile, contents);
      }
      return cfg;
    },
  ]);
};
