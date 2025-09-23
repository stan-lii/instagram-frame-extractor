const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Render has native FFmpeg - no need to set paths explicitly
// FFmpeg should be available in the system PATH

console.log('🎬 Instagram Frame Extractor Server Starting...');
console.log('📍 Native FFmpeg support enabled');

/**
 * Health check endpoint
 */
app.get('/', (req, res) => {
  res.json({
    service: 'Instagram Frame Extractor & Audio Compressor',
    status: 'running',
    platform: 'Render.com',
    ffmpeg: 'native',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /',
      extractFrames: 'POST /extract-frames',
      compressAudio: 'POST /compress-audio',
      download: 'GET /download/:filename',
      test: 'POST /test',
      testAudio: 'POST /test-audio'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// Initialize global temp files storage
global.tempFiles = global.tempFiles || {};

// Cleanup old temp files every hour
setInterval(() => {
  if (global.tempFiles) {
    const now = Date.now();
    Object.keys(global.tempFiles).forEach(sessionId => {
      const fileInfo = global.tempFiles[sessionId];
      if (now - fileInfo.createdAt > 60 * 60 * 1000) { // 1 hour
        fs.unlink(fileInfo.path).catch(() => {}); // Ignore errors
        delete global.tempFiles[sessionId];
      }
    });
  }
}, 60 * 60 * 1000); // Run every hour

/**
 * Main frame extraction endpoint
 */
app.post('/extract-frames', async (req, res) => {
  const startTime = Date.now();
  const sessionId = uuidv4();
  let tempFiles = [];

  console.log(`🎯 [${sessionId}] Starting frame extraction request`);

  try {
    // Parse and validate request body
    const {
      videoUrl,
      maxFrames = 20,
      timeInterval = 2,
      outputWidth = 720,
      outputHeight = 480,
      quality = 85
    } = req.body;

    // Validation
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: videoUrl',
        sessionId
      });
    }

    if (maxFrames < 1 || maxFrames > 50) {
      return res.status(400).json({
        success: false,
        error: 'maxFrames must be between 1 and 50',
        sessionId
      });
    }

    if (timeInterval < 0.5 || timeInterval > 30) {
      return res.status(400).json({
        success: false,
        error: 'timeInterval must be between 0.5 and 30 seconds',
        sessionId
      });
    }

    console.log(`📥 [${sessionId}] Processing: ${videoUrl}`);
    console.log(`⚙️ [${sessionId}] Config: ${maxFrames} frames, ${timeInterval}s interval, ${outputWidth}x${outputHeight}`);

    // Step 1: Download video
    const videoPath = path.join('/tmp', `video_${sessionId}.mp4`);
    tempFiles.push(videoPath);

    console.log(`⬇️ [${sessionId}] Downloading video...`);
    await downloadVideo(videoUrl, videoPath);
    console.log(`✅ [${sessionId}] Video downloaded successfully`);

    // Step 2: Get video metadata
    console.log(`🔍 [${sessionId}] Analyzing video metadata...`);
    const videoMetadata = await getVideoMetadata(videoPath);
    console.log(`📊 [${sessionId}] Video: ${videoMetadata.duration}s, ${videoMetadata.width}x${videoMetadata.height}, ${videoMetadata.fps} fps`);

    // Step 3: Calculate extraction points
    const videoDuration = parseFloat(videoMetadata.duration);
    const framesToExtract = Math.min(maxFrames, Math.floor(videoDuration / timeInterval));
    const extractionPoints = [];

    for (let i = 0; i < framesToExtract; i++) {
      const timestamp = Math.min(i * timeInterval, videoDuration - 0.1);
      extractionPoints.push(timestamp);
    }

    console.log(`🎯 [${sessionId}] Extracting ${framesToExtract} frames at: ${extractionPoints.map(t => t.toFixed(1) + 's').join(', ')}`);

    // Step 4: Extract frames
    const frames = [];
    
    for (let i = 0; i < extractionPoints.length; i++) {
      const timestamp = extractionPoints[i];
      const frameNumber = i + 1;
      
      console.log(`🖼️ [${sessionId}] Extracting frame ${frameNumber}/${extractionPoints.length} at ${timestamp.toFixed(1)}s`);
      
      try {
        const frameBuffer = await extractFrameToBuffer(videoPath, timestamp, outputWidth, outputHeight, quality);
        const frameBase64 = frameBuffer.toString('base64');
        
        frames.push({
          timestamp: Math.round(timestamp * 100) / 100, // Round to 2 decimals
          width: outputWidth,
          height: outputHeight,
          base64: `data:image/jpeg;base64,${frameBase64}`,
          frameNumber: frameNumber,
          size: frameBuffer.length
        });
        
        console.log(`✅ [${sessionId}] Frame ${frameNumber} extracted (${frameBuffer.length} bytes)`);
      } catch (frameError) {
        console.error(`❌ [${sessionId}] Failed to extract frame ${frameNumber}:`, frameError.message);
        // Continue with other frames
      }
    }

    // Step 5: Return results
    const processingTime = Date.now() - startTime;
    
    console.log(`🎉 [${sessionId}] Extraction completed: ${frames.length} frames in ${processingTime}ms`);

    const response = {
      success: true,
      frameCount: frames.length,
      frames: frames,
      metadata: {
        sessionId: sessionId,
        videoDuration: videoDuration,
        videoResolution: `${videoMetadata.width}x${videoMetadata.height}`,
        outputResolution: `${outputWidth}x${outputHeight}`,
        videoFps: parseFloat(videoMetadata.fps),
        extractedAt: new Date().toISOString(),
        processingTimeMs: processingTime,
        requestedFrames: maxFrames,
        actualFrames: frames.length,
        timeInterval: timeInterval,
        quality: quality,
        platform: 'render',
        ffmpegVersion: '4.1.11' // Render's current version
      }
    };

    res.status(200).json(response);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`💥 [${sessionId}] Extraction failed:`, error);

    res.status(500).json({
      success: false,
      error: 'Frame extraction failed',
      details: error.message,
      sessionId: sessionId,
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString()
    });
  } finally {
    // Cleanup temporary files
    await cleanupFiles(tempFiles, sessionId);
  }
});

/**
 * Audio compression endpoint with file size targeting
 */
app.post('/compress-audio', async (req, res) => {
  const startTime = Date.now();
  const sessionId = uuidv4();
  let tempFiles = [];

  console.log(`🎵 [${sessionId}] Starting audio compression request`);

  try {
    // Parse and validate request body
    const {
      audioUrl,
      targetSizeMB = 25,
      outputFormat = 'mp3',
      quality = 'medium', // high, medium, low, or specific bitrate like '128k'
      maxDurationSeconds = null, // Optional: truncate audio if too long
      normalizeAudio = false // Optional: normalize audio levels
    } = req.body;

    // Validation
    if (!audioUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: audioUrl',
        sessionId
      });
    }

    if (targetSizeMB < 0.1 || targetSizeMB > 500) {
      return res.status(400).json({
        success: false,
        error: 'targetSizeMB must be between 0.1 and 500',
        sessionId
      });
    }

    const supportedFormats = ['mp3', 'aac', 'ogg', 'wav', 'm4a'];
    if (!supportedFormats.includes(outputFormat.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Unsupported format. Supported: ${supportedFormats.join(', ')}`,
        sessionId
      });
    }

    console.log(`📥 [${sessionId}] Processing: ${audioUrl}`);
    console.log(`⚙️ [${sessionId}] Target: ${targetSizeMB}MB, Format: ${outputFormat}, Quality: ${quality}`);

    // Step 1: Download audio file
    const inputPath = path.join('/tmp', `audio_input_${sessionId}.tmp`);
    const outputPath = path.join('/tmp', `audio_output_${sessionId}.${outputFormat}`);
    tempFiles.push(inputPath, outputPath);

    console.log(`⬇️ [${sessionId}] Downloading audio...`);
    await downloadVideo(audioUrl, inputPath); // Reuse download function
    console.log(`✅ [${sessionId}] Audio downloaded successfully`);

    // Step 2: Get audio metadata
    console.log(`🔍 [${sessionId}] Analyzing audio metadata...`);
    const audioMetadata = await getAudioMetadata(inputPath);
    console.log(`📊 [${sessionId}] Audio: ${audioMetadata.duration}s, ${audioMetadata.bitrate} kbps, ${audioMetadata.channels} channels`);

    // Step 3: Calculate optimal compression settings
    const targetSizeBytes = targetSizeMB * 1024 * 1024;
    const duration = parseFloat(audioMetadata.duration);
    
    // Apply max duration if specified
    const actualDuration = maxDurationSeconds ? Math.min(duration, maxDurationSeconds) : duration;
    
    const compressionSettings = calculateAudioCompressionSettings(
      targetSizeBytes, 
      actualDuration, 
      outputFormat, 
      quality
    );

    console.log(`🧮 [${sessionId}] Compression settings: ${compressionSettings.bitrate} bitrate, ${compressionSettings.codec} codec`);

    // Step 4: Compress audio
    console.log(`🗜️ [${sessionId}] Starting audio compression...`);
    await compressAudio(inputPath, outputPath, compressionSettings, actualDuration, normalizeAudio, targetSizeBytes);
    
    // Step 5: Get final file info
    const finalStats = await fs.stat(outputPath);
    const finalSizeMB = Math.round((finalStats.size / (1024 * 1024)) * 100) / 100;
    const compressionRatio = Math.round((finalStats.size / (await fs.stat(inputPath)).size) * 100);

    console.log(`✅ [${sessionId}] Compression complete: ${finalSizeMB}MB (${compressionRatio}% of original)`);

    // Step 6: Read compressed file as base64
    const compressedBuffer = await fs.readFile(outputPath);
    const base64Audio = compressedBuffer.toString('base64');
    const mimeType = getMimeType(outputFormat);

    // Step 7: Create temporary download URL (for direct file access)
    const tempDownloadPath = path.join('/tmp', `download_${sessionId}.${outputFormat}`);
    await fs.copyFile(outputPath, tempDownloadPath);
    
    // Store file info for download endpoint
    global.tempFiles = global.tempFiles || {};
    global.tempFiles[sessionId] = {
      path: tempDownloadPath,
      format: outputFormat,
      mimeType: mimeType,
      createdAt: Date.now()
    };

    // Step 8: Return results
    const processingTime = Date.now() - startTime;

    const response = {
      success: true,
      audio: {
        base64: `data:${mimeType};base64,${base64Audio}`,
        format: outputFormat,
        sizeMB: finalSizeMB,
        sizeBytes: finalStats.size,
        duration: actualDuration,
        bitrate: compressionSettings.bitrate,
        compressionRatio: compressionRatio,
        downloadUrl: `https://${req.get('host') || 'localhost'}/download/${sessionId}.${outputFormat}`
      },
      metadata: {
        sessionId: sessionId,
        originalDuration: duration,
        originalBitrate: audioMetadata.bitrate,
        originalChannels: audioMetadata.channels,
        targetSizeMB: targetSizeMB,
        actualSizeMB: finalSizeMB,
        processingTimeMs: processingTime,
        processedAt: new Date().toISOString(),
        settings: compressionSettings,
        truncated: maxDurationSeconds && duration > maxDurationSeconds,
        platform: 'render',
        ffmpegVersion: '4.1.11'
      }
    };

    res.status(200).json(response);

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`💥 [${sessionId}] Audio compression failed:`, error);

    res.status(500).json({
      success: false,
      error: 'Audio compression failed',
      details: error.message,
      sessionId: sessionId,
      processingTimeMs: processingTime,
      timestamp: new Date().toISOString()
    });
  } finally {
    // Cleanup temporary files
    await cleanupFiles(tempFiles, sessionId);
  }
});

/**
 * Test endpoint with sample video
 */
app.post('/test', async (req, res) => {
  console.log('🧪 Test endpoint called');
  
  // Use a small sample video for testing
  const testRequest = {
    videoUrl: 'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_1mb.mp4',
    maxFrames: 3,
    timeInterval: 2,
    outputWidth: 480,
    outputHeight: 360,
    quality: 75
  };
  
  // Forward to main extraction endpoint
  req.body = testRequest;
  return app._router.handle({ ...req, method: 'POST', url: '/extract-frames' }, res);
});

/**
 * Download compressed file endpoint (for OpenAI Whisper compatibility)
 */
app.get('/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const sessionId = filename.split('.')[0];
    
    // Check if file exists in temp storage
    if (!global.tempFiles || !global.tempFiles[sessionId]) {
      return res.status(404).json({
        success: false,
        error: 'File not found or expired'
      });
    }
    
    const fileInfo = global.tempFiles[sessionId];
    
    // Check if file is older than 1 hour (cleanup old files)
    if (Date.now() - fileInfo.createdAt > 60 * 60 * 1000) {
      delete global.tempFiles[sessionId];
      return res.status(410).json({
        success: false,
        error: 'File expired'
      });
    }
    
    // Check if file exists on disk
    try {
      await fs.access(fileInfo.path);
    } catch {
      delete global.tempFiles[sessionId];
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }
    
    // Set proper headers for audio download
    res.setHeader('Content-Type', fileInfo.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');
    
    // Stream the file
    const fileStream = require('fs').createReadStream(fileInfo.path);
    fileStream.pipe(res);
    
    // Clean up file info after download
    fileStream.on('end', () => {
      setTimeout(() => {
        if (global.tempFiles && global.tempFiles[sessionId]) {
          fs.unlink(fileInfo.path).catch(() => {}); // Ignore cleanup errors
          delete global.tempFiles[sessionId];
        }
      }, 5000); // Give 5 seconds for any additional downloads
    });
    
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: 'Download failed',
      details: error.message
    });
  }
});

/**
 * Test audio compression endpoint
 */
app.post('/test-audio', async (req, res) => {
  console.log('🧪 Audio test endpoint called');
  
  const testRequest = {
    audioUrl: 'https://sample-videos.com/zip/10/mp3/mp3-sample.mp3',
    targetSizeMB: 5,
    outputFormat: 'mp3',
    quality: 'medium'
  };
  
  // Forward to audio compression endpoint
  req.body = testRequest;
  return app._router.handle({ ...req, method: 'POST', url: '/compress-audio' }, res);
});

/**
 * Download video from URL
 */
async function downloadVideo(videoUrl, outputPath) {
  try {
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
      timeout: 120000, // 2 minute timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RenderFrameExtractor/1.0)'
      }
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Failed to download video: ${error.message}`);
  }
}

/**
 * Get video metadata using FFprobe
 */
function getVideoMetadata(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(new Error(`FFprobe failed: ${err.message}`));
        return;
      }

      const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
      if (!videoStream) {
        reject(new Error('No video stream found in file'));
        return;
      }

      // Calculate FPS from r_frame_rate (fraction)
      let fps = 30; // default
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
        if (den && den !== 0) {
          fps = Math.round((num / den) * 100) / 100;
        }
      }

      resolve({
        duration: metadata.format.duration,
        width: videoStream.width,
        height: videoStream.height,
        fps: fps,
        codec: videoStream.codec_name,
        bitrate: metadata.format.bit_rate
      });
    });
  });
}

/**
 * Get audio metadata using FFprobe
 */
function getAudioMetadata(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        reject(new Error(`FFprobe failed: ${err.message}`));
        return;
      }

      const audioStream = metadata.streams.find(stream => stream.codec_type === 'audio');
      if (!audioStream) {
        reject(new Error('No audio stream found in file'));
        return;
      }

      resolve({
        duration: metadata.format.duration,
        bitrate: Math.round(parseInt(metadata.format.bit_rate || audioStream.bit_rate || 128000) / 1000),
        sampleRate: audioStream.sample_rate || 44100,
        channels: audioStream.channels || 2,
        codec: audioStream.codec_name,
        format: metadata.format.format_name
      });
    });
  });
}

/**
 * Calculate optimal compression settings based on target size
 */
function calculateAudioCompressionSettings(targetSizeBytes, durationSeconds, outputFormat, quality) {
  // Calculate target bitrate: (target_size_bits / duration) with safety margin
  const targetSizeBits = targetSizeBytes * 8;
  const safetyMargin = 0.9; // Use 90% of target to account for container overhead
  const maxBitrate = Math.floor((targetSizeBits * safetyMargin) / durationSeconds / 1000); // kbps

  let codec, bitrate, preset;

  // Set codec based on format
  switch (outputFormat.toLowerCase()) {
    case 'mp3':
      codec = 'libmp3lame';
      break;
    case 'aac':
    case 'm4a':
      codec = 'aac';
      break;
    case 'ogg':
      codec = 'libvorbis';
      break;
    case 'wav':
      codec = 'pcm_s16le';
      break;
    default:
      codec = 'libmp3lame';
  }

  // Set bitrate based on quality setting
  if (typeof quality === 'string' && quality.includes('k')) {
    // Specific bitrate provided (e.g., "128k")
    bitrate = Math.min(parseInt(quality), maxBitrate);
  } else {
    // Quality presets
    const qualityPresets = {
      'high': Math.min(320, maxBitrate),
      'medium': Math.min(192, maxBitrate), 
      'low': Math.min(128, maxBitrate)
    };
    bitrate = qualityPresets[quality] || qualityPresets['medium'];
  }

  // Ensure minimum bitrate for quality
  const minBitrates = { mp3: 64, aac: 64, ogg: 64, wav: 256 };
  const minBitrate = minBitrates[outputFormat] || 64;
  bitrate = Math.max(bitrate, minBitrate);

  // Final check against target size
  if (bitrate > maxBitrate) {
    console.warn(`Calculated bitrate ${bitrate}k exceeds target size, using ${maxBitrate}k`);
    bitrate = maxBitrate;
  }

  return {
    codec,
    bitrate: `${bitrate}k`,
    preset: codec === 'libmp3lame' ? 'standard' : 'medium'
  };
}

/**
 * Compress audio file using FFmpeg
 */
function compressAudio(inputPath, outputPath, settings, maxDuration, normalize, targetSizeBytes) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath);

    // Apply audio filters if needed
    const filters = [];
    if (normalize) {
      filters.push('loudnorm=I=-16:LRA=11:TP=-1.5'); // EBU R128 normalization
    }

    if (filters.length > 0) {
      command = command.audioFilters(filters);
    }

    // Set duration limit if specified
    if (maxDuration) {
      command = command.duration(maxDuration);
    }

    // Configure audio encoding
    command = command
      .audioCodec(settings.codec)
      .audioBitrate(settings.bitrate)
      .audioChannels(2) // Stereo output
      .audioFrequency(44100) // Standard sample rate
      .format(getFormatFromCodec(settings.codec));

    // Add file size limit
    const targetSizeMB = Math.ceil(targetSizeBytes / (1024 * 1024));
    command = command.outputOptions(['-fs', `${targetSizeMB}M`]);

    // Add quality options for specific codecs
    if (settings.codec === 'libmp3lame') {
      command = command.outputOptions(['-q:a', '2']); // High quality VBR
    } else if (settings.codec === 'aac') {
      command = command.outputOptions(['-profile:a', 'aac_low']);
    } else if (settings.codec === 'libvorbis') {
      command = command.outputOptions(['-q:a', '6']); // Ogg quality level
    }

    command
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log(`🔧 FFmpeg command: ${commandLine}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          console.log(`🗜️ Processing: ${Math.round(progress.percent)}%`);
        }
      })
      .on('end', () => {
        resolve();
      })
      .on('error', (err) => {
        reject(new Error(`Audio compression failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Get MIME type for audio format
 */
function getMimeType(format) {
  const mimeTypes = {
    'mp3': 'audio/mpeg',
    'aac': 'audio/aac',
    'm4a': 'audio/mp4',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav'
  };
  return mimeTypes[format.toLowerCase()] || 'audio/mpeg';
}

/**
 * Get format string for FFmpeg based on codec
 */
function getFormatFromCodec(codec) {
  const formats = {
    'libmp3lame': 'mp3',
    'aac': 'adts',
    'libvorbis': 'ogg',
    'pcm_s16le': 'wav'
  };
  return formats[codec] || 'mp3';
}

/**
 * Extract frame to buffer using FFmpeg
 */
function extractFrameToBuffer(videoPath, timestamp, width, height, quality) {
  return new Promise((resolve, reject) => {
    const frameBuffers = [];

    const command = ffmpeg(videoPath)
      .seekInput(timestamp)
      .frames(1)
      .size(`${width}x${height}`)
      .format('image2')
      .outputOptions([
        '-q:v', Math.round((100 - quality) / 4), // Convert quality percentage to FFmpeg q scale
        '-pix_fmt', 'yuvj420p' // Better JPEG compatibility
      ])
      .on('error', (err) => {
        reject(new Error(`FFmpeg frame extraction failed: ${err.message}`));
      })
      .on('end', () => {
        if (frameBuffers.length === 0) {
          reject(new Error('No frame data received'));
          return;
        }
        const frameBuffer = Buffer.concat(frameBuffers);
        resolve(frameBuffer);
      });

    // Capture output as buffer
    const stream = command.format('mjpeg').pipe();
    
    stream.on('data', (chunk) => {
      frameBuffers.push(chunk);
    });

    stream.on('error', (err) => {
      reject(new Error(`Stream error: ${err.message}`));
    });
  });
}

/**
 * Cleanup temporary files
 */
async function cleanupFiles(filePaths, sessionId) {
  console.log(`🧹 [${sessionId}] Cleaning up ${filePaths.length} temporary files`);
  
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
      console.log(`🗑️ [${sessionId}] Cleaned: ${path.basename(filePath)}`);
    } catch (error) {
      console.warn(`⚠️ [${sessionId}] Cleanup failed for ${path.basename(filePath)}: ${error.message}`);
    }
  }
}

/**
 * Error handling middleware
 */
app.use((error, req, res, next) => {
  console.error('💥 Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    details: error.message,
    timestamp: new Date().toISOString()
  });
});

/**
 * 404 handler
 */
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableEndpoints: ['/', '/health', '/extract-frames', '/compress-audio', '/download/:filename', '/test', '/test-audio'],
    method: req.method,
    path: req.originalUrl
  });
});

/**
 * Start server
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Instagram Frame Extractor & Audio Compressor running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🎬 Extract frames: POST http://localhost:${PORT}/extract-frames`);
  console.log(`🎵 Compress audio: POST http://localhost:${PORT}/compress-audio`);
  console.log(`📥 Download files: GET http://localhost:${PORT}/download/:filename`);
  console.log(`🧪 Test video: POST http://localhost:${PORT}/test`);
  console.log(`🧪 Test audio: POST http://localhost:${PORT}/test-audio`);
  console.log(`⚙️ Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down gracefully');
  process.exit(0);
});

module.exports = app;
