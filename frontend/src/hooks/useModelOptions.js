// (R-2) 從 App.jsx 搬出：模型清單、預設模型、自訂模型開關。openrouterConnected 改變時重新讀取 /api/model-options
import { useState, useEffect } from 'react';
import { apiFetch } from '../api';

export function useModelOptions(openrouterConnected) {
  // (V1-3) 模型初始值由後端 /api/model-options 決定（見下方 effect）；載入前為空，送出會被停用
  const [model, setModel] = useState("");
  const [presets, setPresets] = useState([]); // 後端 ALLOWED_MODELS 可直接選的項目
  const [defaultModel, setDefaultModel] = useState(null); // 後端決定的預設模型，null = 沒有可用模型
  const [optionsLoading, setOptionsLoading] = useState(true);
  // (G2-6) 是否允許自訂模型輸入（後端 allow_custom；目前欄位尚未回傳時視為 false）
  const [allowCustom, setAllowCustom] = useState(false);
  const [freeModels, setFreeModels] = useState([]);
  const [freeModelsLoading, setFreeModelsLoading] = useState(true);
  const [isCustomModel, setIsCustomModel] = useState(false); //即時輸入模型

  // 載入 OpenRouter 免費模型清單
  useEffect(() => {
    apiFetch(`/api/free-models`)
      .then(res => res.json())
      .then(data => setFreeModels(data.models || []))
      .catch(err => console.error("無法載入免費模型:", err))
      .finally(() => setFreeModelsLoading(false));
  }, []);

  // (V1-3) 載入模型選項：presets、預設模型都由後端決定；失敗時視為沒有 presets 且沒有預設
  // (G2-10) 依賴 openrouter_connected：連結／中斷後重新抓，allow_custom 立即切換（不用重新整理）
  useEffect(() => {
    apiFetch(`/api/model-options`)
      .then(res => {
        if (!res.ok) throw new Error(`model-options ${res.status}`);
        return res.json();
      })
      .then(data => {
        const nextPresets = data.presets || [];
        const nextDefault = data.default_model || null;
        setPresets(nextPresets);
        setDefaultModel(nextDefault);
        setAllowCustom(data.allow_custom === true); // (G2-6)
        setModel(prev => prev || nextDefault || "");
      })
      .catch(err => {
        console.error("無法載入模型選項:", err);
        setPresets([]);
        setDefaultModel(null);
        setAllowCustom(false); // (G2-6)
      })
      .finally(() => setOptionsLoading(false));
  }, [openrouterConnected]);

  // (G2-6) 不允許自訂模型（例如訪客）時，若目前正在自訂輸入模式，就切回預設模型
  useEffect(() => {
    if (!optionsLoading && !allowCustom && isCustomModel) {
      // (R-2) 搬移前在 App.jsx 已是同一段程式（規則當時沒分析到大元件）；行為不變，修法記在 BUGS B19
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCustomModel(false);
      if (model !== (defaultModel || '')) setModel(defaultModel || '');
    }
  }, [optionsLoading, allowCustom, isCustomModel, model, defaultModel]);

  return { model, setModel, presets, defaultModel, optionsLoading, allowCustom, freeModels, freeModelsLoading, isCustomModel, setIsCustomModel };
}
