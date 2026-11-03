const fs = require('fs');
const path = require('path');

function generateChime(filename, duration = 1.8, sampleRate = 44100) {
  const dir = path.dirname(filename);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const numSamples = Math.floor(sampleRate * duration);
  const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5

  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let env = 1.0;
    if (t < 0.05) {
      env = t / 0.05;
    } else {
      env = Math.exp(-3.0 * (t - 0.05));
    }

    let val = 0.0;
    for (let f of freqs) {
      val += Math.sin(2.0 * Math.PI * f * t);
    }
    val = (val / freqs.length) * env * 0.8;
    const clamped = Math.max(-32767, Math.min(32767, Math.floor(val * 32767)));
    samples[i] = clamped;
  }

  const numChannels = 1;
  const bytesPerSample = 2;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const subchunk2Size = numSamples * numChannels * bytesPerSample;
  const chunkSize = 36 + subchunk2Size;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(chunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34); // 16 bits
  header.write('data', 36);
  header.writeUInt32LE(subchunk2Size, 40);

  const dataBuffer = Buffer.from(samples.buffer);
  const fullFile = Buffer.concat([header, dataBuffer]);

  fs.writeFileSync(filename, fullFile);
  console.log('[AUDIO GEN SUCCESS] Created Android native chime at:', filename);
}

const targetPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', 'raw', 'pbp_alarm_chime.wav');
generateChime(targetPath);
