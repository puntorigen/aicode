const { execSync } = require('child_process');
const os = require('os');

function getSystemLocaleSync() {
  const platform = os.platform();
  //console.log('Platform:', platform);

  try {
    let locale = '';
    if (platform === 'darwin') {
      // macOS
      const stdout = execSync('defaults read -g AppleLocale');
      locale = stdout.toString().trim();
    } else if (platform === 'win32') {
      // Windows
      const stdout = execSync('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\Language" /v InstallLanguage');
      const match = stdout.toString().match(/\s(\w+)\s*$/);
      locale = match ? match[1].trim() : 'Unknown';
    } else {
      //console.log('Unsupported platform:', platform);
      return '';
    }

    // Extracting just the language part from the locale
    const languageCode = locale.split('_')[0];
    return languageCode;

  } catch (error) {
    //console.error('Error executing command:', error);
    return '';
  }
}

module.exports = getSystemLocaleSync;
