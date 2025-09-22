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
    service: 'Instagram Frame Extractor',
    status: 'running',
    platform: 'Render.com',
    ffmpeg: 'native',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: 'GET /',
      extractFrames: 'POST /extract-frames',
      test: 'POST /test'
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
    availableEndpoints: ['/', '/health', '/extract-frames', '/test'],
    method: req.method,
    path: req.originalUrl
  });
});

/**
 * Start server
 */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Instagram Frame Extractor running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🎬 Extract frames: POST http://localhost:${PORT}/extract-frames`);
  console.log(`🧪 Test endpoint: POST http://localhost:${PORT}/test`);
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
