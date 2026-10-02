// Expo config plugin: raise every pod's iOS deployment target to at least the
// app's. Xcode 27 accepts iOS 15.0 and later, and some pods still declare less
// (react-native-svg 12.4, async-storage 13.4), which fails the build.

const { createRunOncePlugin, withPodfile } = require("expo/config-plugins");

const MIN_IOS = "15.1";
const MARKER = "# waap-example: raise pod deployment targets";

const SNIPPET = `
    ${MARKER}
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build|
        if build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < ${MIN_IOS}
          build.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MIN_IOS}'
        end
      end
    end
`;

/** The Podfile with the raise added at the start of `post_install`. */
const raisePodDeploymentTargets = (podfile) => {
  if (podfile.includes(MARKER)) return podfile;
  const hook = "post_install do |installer|";
  const at = podfile.indexOf(hook);
  if (at === -1) {
    throw new Error(
      "ios-pod-deployment-target: the Podfile has no post_install block",
    );
  }
  const end = at + hook.length;
  return podfile.slice(0, end) + SNIPPET + podfile.slice(end);
};

const withPodDeploymentTarget = (config) =>
  withPodfile(config, (podConfig) => {
    podConfig.modResults.contents = raisePodDeploymentTargets(
      podConfig.modResults.contents,
    );
    return podConfig;
  });

module.exports = createRunOncePlugin(
  withPodDeploymentTarget,
  "ios-pod-deployment-target",
  "1.0.0",
);
module.exports.raisePodDeploymentTargets = raisePodDeploymentTargets;
