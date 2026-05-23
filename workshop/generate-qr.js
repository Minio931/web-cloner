const qrcode = require('qrcode');

const url = process.argv[2];
if (!url) {
  console.error('Uzycie: node generate-qr.js <URL>');
  console.error('Przyklad: node generate-qr.js http://192.168.1.100:3000/victim');
  process.exit(1);
}

qrcode.toFile('workshop-qr.png', url, {
  width: 500,
  margin: 2,
  color: { dark: '#000000', light: '#ffffff' },
  errorCorrectionLevel: 'M',
}, (err) => {
  if (err) throw err;
  console.log(`QR kod zapisany: workshop-qr.png`);
  console.log(`URL: ${url}`);
});
