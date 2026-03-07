/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { Download, FolderDown, Github, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import JSZip from 'jszip';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function parseGitHubUrl(url: string) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname !== 'github.com') return null;

    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1];

    if (parts.length === 2) {
      return { owner, repo, branch: 'HEAD', path: '' };
    }

    if (parts[2] === 'tree' && parts.length > 3) {
      const branch = parts[3];
      const path = parts.slice(4).join('/');
      return { owner, repo, branch, path };
    }

    return null;
  } catch (e) {
    return null;
  }
}

export default function App() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!url.trim()) {
      setStatus('error');
      setMessage('Please enter a GitHub URL.');
      return;
    }

    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      setStatus('error');
      setMessage('Invalid GitHub URL. Please provide a valid repository or folder URL.');
      return;
    }

    setStatus('loading');
    setMessage('Fetching repository info...');
    setProgress(0);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const { owner, repo, branch, path } = parsed;
      
      let targetBranch = branch;
      if (branch === 'HEAD') {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { signal });
        if (!repoRes.ok) throw new Error('Failed to fetch repository info.');
        const repoData = await repoRes.json();
        targetBranch = repoData.default_branch;
      }

      let treeData = null;
      let treeRes = null;
      let finalPath = path;

      if (targetBranch !== 'HEAD') {
        // Handle branches with slashes by iteratively checking the API
        const pathSegments = path ? path.split('/') : [];
        let currentBranch = targetBranch;
        let currentPathSegments = [...pathSegments];

        while (true) {
          setMessage(`Fetching directory structure...`);
          const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${currentBranch}?recursive=1`;
          treeRes = await fetch(treeUrl, { signal });
          
          if (treeRes.ok) {
            treeData = await treeRes.json();
            targetBranch = currentBranch;
            finalPath = currentPathSegments.join('/');
            break;
          } else if (treeRes.status === 404 && currentPathSegments.length > 0) {
            currentBranch += '/' + currentPathSegments.shift();
          } else {
            break;
          }
        }
      } else {
        const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`;
        treeRes = await fetch(treeUrl, { signal });
        if (treeRes.ok) {
          treeData = await treeRes.json();
        }
      }

      if (!treeRes || !treeRes.ok) {
        if (treeRes?.status === 404) {
          throw new Error("Repository, branch, or folder not found. Note: Private repositories are not supported without a token.");
        } else if (treeRes?.status === 403) {
          throw new Error("GitHub API rate limit exceeded. Please try again later.");
        }
        throw new Error(`Failed to fetch repository tree: ${treeRes?.statusText || 'Unknown error'}`);
      }

      if (treeData.truncated) {
        console.warn("The repository tree is too large and was truncated.");
      }

      const prefix = finalPath ? `${finalPath}/` : '';
      const files = treeData.tree.filter((item: any) => 
        item.type === 'blob' && (finalPath === '' || item.path.startsWith(prefix))
      );

      if (files.length === 0) {
        throw new Error("No files found in the specified folder.");
      }

      const zip = new JSZip();
      let completed = 0;
      const totalFiles = files.length;

      const chunkSize = 10;
      for (let i = 0; i < files.length; i += chunkSize) {
        if (signal.aborted) throw new Error('Download cancelled.');
        
        const chunk = files.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (file: any) => {
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${targetBranch}/${file.path}`;
          try {
            const fileRes = await fetch(rawUrl, { signal });
            if (!fileRes.ok) throw new Error(`Failed to fetch ${file.path}`);
            const blob = await fileRes.blob();
            
            const zipPath = finalPath ? file.path.substring(prefix.length) : file.path;
            zip.file(zipPath, blob);
          } catch (err) {
            console.error(err);
          } finally {
            completed++;
            setProgress((completed / totalFiles) * 100);
            setMessage(`Downloading files... (${completed}/${totalFiles})`);
          }
        }));
      }

      if (signal.aborted) throw new Error('Download cancelled.');

      setMessage('Generating ZIP file...');
      const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
        setProgress(metadata.percent);
      });
      
      const downloadUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      const folderName = finalPath ? finalPath.split('/').pop() : repo;
      a.download = `${folderName}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(downloadUrl);
      
      setStatus('success');
      setMessage('Download complete!');
      setProgress(100);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        setStatus('idle');
        setMessage('');
      } else {
        setStatus('error');
        setMessage(err.message || 'An unexpected error occurred.');
      }
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col items-center justify-center p-4 font-sans">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl overflow-hidden border border-slate-100">
        <div className="bg-slate-900 p-8 text-center relative overflow-hidden">
          <div className="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-white via-transparent to-transparent"></div>
          <div className="relative z-10 flex flex-col items-center">
            <div className="w-16 h-16 bg-white/10 rounded-2xl flex items-center justify-center mb-4 backdrop-blur-sm border border-white/20">
              <FolderDown className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-2 tracking-tight">GitHub Folder Downloader</h1>
            <p className="text-slate-400 text-sm max-w-sm mx-auto">
              Download any specific folder from a GitHub repository as a ZIP file without cloning the entire repo.
            </p>
          </div>
        </div>

        <div className="p-8">
          <form onSubmit={handleDownload} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="url" className="block text-sm font-medium text-slate-700">
                GitHub Folder URL
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Github className="h-5 w-5 text-slate-400" />
                </div>
                <input
                  type="url"
                  id="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/main/folder"
                  className="block w-full pl-10 pr-3 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm transition-shadow bg-slate-50 hover:bg-white"
                  disabled={status === 'loading'}
                />
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Example: <span className="font-mono bg-slate-100 px-1 py-0.5 rounded text-slate-600">https://github.com/dhanjeerider/wpthems/tree/main/WEB</span>
              </p>
            </div>

            {status === 'loading' ? (
              <div className="space-y-4 bg-slate-50 p-4 rounded-xl border border-slate-100">
                <div className="flex items-center justify-between text-sm font-medium text-slate-700">
                  <div className="flex items-center space-x-2">
                    <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                    <span>{message}</span>
                  </div>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
                  <div 
                    className="bg-indigo-600 h-2 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="w-full py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
                >
                  Cancel Download
                </button>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!url.trim()}
                className={cn(
                  "w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-all",
                  !url.trim() && "opacity-50 cursor-not-allowed"
                )}
              >
                <Download className="w-5 h-5 mr-2" />
                Download ZIP
              </button>
            )}

            {status === 'error' && (
              <div className="rounded-xl bg-red-50 p-4 border border-red-100 flex items-start space-x-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{message}</p>
              </div>
            )}

            {status === 'success' && (
              <div className="rounded-xl bg-emerald-50 p-4 border border-emerald-100 flex items-start space-x-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-emerald-700">{message}</p>
              </div>
            )}
          </form>
        </div>
        
        <div className="bg-slate-50 px-8 py-4 border-t border-slate-100 text-center">
          <p className="text-xs text-slate-500">
            Downloads are processed entirely in your browser. No data is sent to our servers.
          </p>
        </div>
      </div>
    </div>
  );
}

