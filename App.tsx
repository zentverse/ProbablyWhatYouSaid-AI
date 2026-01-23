/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import React, { useState, useEffect } from 'react';
import { Mic, Upload, Sparkles, AlertTriangle, Moon, Sun } from 'lucide-react';
import AudioRecorder from './components/AudioRecorder';
import FileUploader from './components/FileUploader';
import TranscriptionDisplay from './components/TranscriptionDisplay';
import Button from './components/Button';
import { transcribeAudio } from './services/geminiService';
import { AppStatus, AudioData, TranscriptionResponse } from './types';

function App() {
  const [mode, setMode] = useState<'record' | 'upload'>('record');
  const [status, setStatus] = useState<AppStatus>('idle');
  const [audioData, setAudioData] = useState<AudioData | null>(null);
  const [result, setResult] = useState<TranscriptionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Initialize dark mode based on system preference
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // Toggle Dark Mode
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const toggleDarkMode = () => setIsDarkMode(!isDarkMode);

  const handleAudioReady = (data: AudioData) => {
    setAudioData(data);
    setError(null);
    setResult(null); // Clear previous results
  };

  const handleTranscribe = async () => {
    if (!audioData) return;

    setStatus('processing');
    setError(null);

    try {
      const data = await transcribeAudio(audioData.base64, audioData.mimeType);
      setResult(data as TranscriptionResponse);
      setStatus('success');
    } catch (err) {
      console.error(err);
      setError("An error occurred during transcription. Please try again.");
      setStatus('error');
    }
  };

  const handleReset = () => {
    setAudioData(null);
    setResult(null);
    setStatus('idle');
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 pb-20 transition-colors duration-300">
      {/* Header */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-10 transition-colors duration-300">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="bg-indigo-600 p-2 rounded-lg text-white shadow-lg shadow-indigo-500/30">
              <Sparkles size={20} />
            </div>
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-violet-600 dark:from-indigo-400 dark:to-violet-400">
              EchoScript AI
            </h1>
          </div>
          <div className="flex items-center space-x-4">
            <div className="text-sm text-slate-500 dark:text-slate-400 font-medium hidden sm:block">
              Powered by Gemini 3 Flash Preview
            </div>
            <button
              onClick={toggleDarkMode}
              className="p-2 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label="Toggle Dark Mode"
            >
              {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10">
        
        {/* Intro */}
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-4">
            Turn your audio into accurate text
          </h2>
          <p className="text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Upload a file or record directly to get speaker-identified transcripts with timestamps and language detection instantly.
          </p>
        </div>

        {/* Status Error */}
        {status === 'error' && error && (
          <div className="mb-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 flex items-start text-red-700 dark:text-red-400">
            <AlertTriangle className="mr-3 flex-shrink-0 mt-0.5" size={20} />
            <p>{error}</p>
          </div>
        )}

        {/* Input Selection Tabs */}
        {!result && (
            <div className="bg-white dark:bg-slate-900 p-1 rounded-xl shadow-sm border border-slate-200 dark:border-slate-800 inline-flex mb-8 w-full sm:w-auto transition-colors duration-300">
            <button
                onClick={() => { setMode('record'); handleReset(); }}
                className={`flex-1 sm:flex-none flex items-center justify-center px-6 py-2.5 rounded-lg text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-slate-900 focus:ring-indigo-500 ${
                mode === 'record' 
                    ? 'bg-indigo-600 text-white shadow-sm' 
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
                disabled={status === 'processing'}
            >
                <Mic size={16} className="mr-2" />
                Record Audio
            </button>
            <button
                onClick={() => { setMode('upload'); handleReset(); }}
                className={`flex-1 sm:flex-none flex items-center justify-center px-6 py-2.5 rounded-lg text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-1 dark:focus:ring-offset-slate-900 focus:ring-indigo-500 ${
                mode === 'upload' 
                    ? 'bg-indigo-600 text-white shadow-sm' 
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
                disabled={status === 'processing'}
            >
                <Upload size={16} className="mr-2" />
                Upload File
            </button>
            </div>
        )}

        {/* Main Content Area */}
        <div className="space-y-8">
          
          {/* Input Section */}
          {!result && status !== 'processing' && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-6 sm:p-8 transition-colors duration-300">
              {mode === 'record' ? (
                <AudioRecorder onAudioCaptured={handleAudioReady} disabled={status === 'processing'} />
              ) : (
                <FileUploader onFileSelected={handleAudioReady} disabled={status === 'processing'} />
              )}

              {audioData && (
                <div className="mt-6 flex justify-end pt-6 border-t border-slate-100 dark:border-slate-800">
                  <Button 
                    onClick={handleTranscribe} 
                    isLoading={status === 'processing'}
                    className="w-full sm:w-auto"
                    icon={<Sparkles size={16} />}
                  >
                    Generate Transcript
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Processing State */}
          {status === 'processing' && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-800 p-12 text-center transition-colors duration-300">
              <div className="flex justify-center mb-6">
                 <div className="relative">
                    <div className="w-16 h-16 border-4 border-indigo-100 dark:border-indigo-900 border-t-indigo-600 dark:border-t-indigo-500 rounded-full animate-spin"></div>
                    <div className="absolute top-0 left-0 w-full h-full flex items-center justify-center">
                        <Sparkles size={24} className="text-indigo-600 dark:text-indigo-400 animate-pulse" />
                    </div>
                 </div>
              </div>
              <h3 className="text-xl font-semibold text-slate-900 dark:text-white mb-2">Analyzing Audio...</h3>
              <p className="text-slate-500 dark:text-slate-400 max-w-sm mx-auto">
                Gemini is identifying speakers, detecting languages, and generating your transcript. This usually takes just a few seconds.
              </p>
            </div>
          )}

          {/* Results Section */}
          {result && status === 'success' && (
            <div>
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Transcription Results</h2>
                    <Button onClick={handleReset} variant="secondary">Start Over</Button>
                </div>
                <TranscriptionDisplay data={result} />
            </div>
          )}
        </div>

        {/* Disclaimer */}
        <div className="mt-16 text-center text-xs text-slate-500 dark:text-slate-400 max-w-2xl mx-auto leading-relaxed border-t border-slate-200 dark:border-slate-800 pt-8 transition-colors duration-300">
            <p className="mb-2">
            By using this feature, you confirm that you have the necessary rights to any content that you upload. Do not upload content that infringes on others’ intellectual property or privacy rights. Your use of this generative AI service is subject to our <a href="https://policies.google.com/terms/generative-ai/use-policy" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700 dark:hover:text-slate-300 transition-colors">Prohibited Use Policy</a>.
            </p>
            <p>
            Please note that uploads from Google Workspace may be used to develop and improve Google products and services in accordance with our <a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-700 dark:hover:text-slate-300 transition-colors">terms</a>.
            </p>
        </div>

      </main>
    </div>
  );
}

export default App;