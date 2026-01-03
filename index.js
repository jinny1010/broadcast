// Broadcast Message Extension for SillyTavern
// 여러 채팅에 동일한 메시지를 보내고 자동으로 숨김 처리

import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    chat,
    saveChatDebounced,
} from '../../../../script.js';

import { extension_settings } from '../../../extensions.js';
import { callPopup } from '../../../popup.js';

const extensionName = 'broadcast-message';

// 기본 설정
const defaultSettings = {
    autoHide: true,
    delayBetweenChats: 2000,
};

// 상태 관리
let isProcessing = false;
let selectedChats = [];
let pendingHide = new Map();

/**
 * 설정 초기화
 */
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
}

/**
 * 캐릭터 목록 가져오기 (DOM에서 직접 읽기)
 */
async function getChatList() {
    const characters = [];
    
    // 캐릭터 목록에서 가져오기
    $('.character_select').each(function() {
        const $this = $(this);
        const chid = $this.attr('chid');
        const name = $this.find('.ch_name').text().trim();
        const avatar = $this.find('img').attr('src') || '';
        
        if (name) {
            characters.push({
                chid: chid,
                name: name,
                avatar: avatar,
            });
        }
    });
    
    // 그룹도 가져오기
    $('.group_select').each(function() {
        const $this = $(this);
        const grid = $this.attr('grid');
        const name = $this.find('.ch_name').text().trim();
        
        if (name) {
            characters.push({
                grid: grid,
                name: name,
                isGroup: true,
            });
        }
    });
    
    return characters;
}

/**
 * 채팅 선택 UI 열기
 */
async function openChatSelector() {
    if (isProcessing) {
        toastr.warning('이미 브로드캐스트가 진행 중입니다.');
        return;
    }
    
    const chats = await getChatList();
    
    if (chats.length === 0) {
        toastr.info('사용 가능한 캐릭터가 없습니다.');
        return;
    }
    
    const popupContent = `
        <div style="display:flex; flex-direction:column; gap:15px; min-width:400px;">
            <h3 style="margin:0; text-align:center;">📢 브로드캐스트 메시지</h3>
            
            <div style="max-height:200px; overflow-y:auto; border:1px solid #444; border-radius:5px; padding:10px;">
                <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer; border-bottom:1px solid #444; margin-bottom:10px;">
                    <input type="checkbox" id="broadcast-select-all" style="width:18px; height:18px;">
                    <span style="font-weight:bold;">전체 선택</span>
                </label>
                ${chats.map((chatItem, index) => `
                    <label style="display:flex; align-items:center; gap:8px; padding:5px; cursor:pointer;">
                        <input type="checkbox" 
                               class="broadcast-chat-checkbox" 
                               data-index="${index}"
                               data-chid="${chatItem.chid || ''}"
                               data-grid="${chatItem.grid || ''}"
                               data-name="${chatItem.name}"
                               data-is-group="${chatItem.isGroup || false}"
                               style="width:18px; height:18px;">
                        <span>${chatItem.isGroup ? '👥 ' : ''}${chatItem.name}</span>
                    </label>
                `).join('')}
            </div>
            
            <div>
                <label style="display:block; margin-bottom:5px;">보낼 메시지:</label>
                <textarea id="broadcast-message" rows="3" style="width:100%; padding:8px; border-radius:5px; border:1px solid #444; background:#1a1a2e; color:#fff; resize:vertical;" placeholder="여러 캐릭터에게 보낼 메시지를 입력하세요..."></textarea>
            </div>
            
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="broadcast-auto-hide" ${extension_settings[extensionName].autoHide ? 'checked' : ''} style="width:18px; height:18px;">
                <span>보낸 메시지와 응답 자동 숨김</span>
            </label>
        </div>
    `;
    
    const result = await callPopup(popupContent, 'confirm', '', { okButton: '전송', cancelButton: '취소' });
    
    if (result) {
        const message = $('#broadcast-message').val().trim();
        const autoHide = $('#broadcast-auto-hide').is(':checked');
        
        if (!message) {
            toastr.warning('메시지를 입력해주세요.');
            return;
        }
        
        selectedChats = [];
        $('.broadcast-chat-checkbox:checked').each(function() {
            selectedChats.push({
                chid: $(this).data('chid'),
                grid: $(this).data('grid'),
                name: $(this).data('name'),
                isGroup: $(this).data('is-group') === true || $(this).data('is-group') === 'true',
            });
        });
        
        if (selectedChats.length === 0) {
            toastr.warning('최소 하나의 캐릭터를 선택해주세요.');
            return;
        }
        
        extension_settings[extensionName].autoHide = autoHide;
        saveSettingsDebounced();
        
        await broadcastMessage(message, autoHide);
    }
    
    // 전체 선택 이벤트 (팝업 열릴 때)
    $(document).off('change', '#broadcast-select-all').on('change', '#broadcast-select-all', function() {
        $('.broadcast-chat-checkbox').prop('checked', this.checked);
    });
}

/**
 * 하이드 개수 입력 모달 열기
 */
async function openHideModal() {
    const popupContent = `
        <div style="display:flex; flex-direction:column; gap:15px; min-width:300px;">
            <h3 style="margin:0; text-align:center;">🙈 메시지 숨기기</h3>
            
            <div>
                <label style="display:block; margin-bottom:5px;">숨길 메시지 개수:</label>
                <input type="number" id="hide-count" min="1" max="100" value="2" 
                       style="width:100%; padding:10px; border-radius:5px; border:1px solid #444; background:#1a1a2e; color:#fff; font-size:16px;">
                <small style="color:#888; margin-top:5px; display:block;">마지막 메시지부터 숨깁니다</small>
            </div>
        </div>
    `;
    
    const result = await callPopup(popupContent, 'confirm', '', { okButton: '숨기기', cancelButton: '취소' });
    
    if (result) {
        const count = parseInt($('#hide-count').val(), 10);
        
        if (isNaN(count) || count < 1) {
            toastr.warning('올바른 숫자를 입력해주세요.');
            return;
        }
        
        await hideLastMessages(count);
    }
}

/**
 * 마지막 N개 메시지 숨기기
 */
async function hideLastMessages(count) {
    const messages = $('#chat .mes:not(.hidden-message)');
    const totalMessages = messages.length;
    
    if (totalMessages === 0) {
        toastr.info('숨길 메시지가 없습니다.');
        return;
    }
    
    const hideCount = Math.min(count, totalMessages);
    
    toastr.info(`마지막 ${hideCount}개 메시지를 숨기는 중...`);
    
    // 마지막 메시지부터 역순으로 숨김
    for (let i = 0; i < hideCount; i++) {
        const msgIndex = totalMessages - 1 - i;
        await hideMessageByIndex(msgIndex);
        await sleep(100); // 약간의 딜레이
    }
    
    toastr.success(`${hideCount}개 메시지를 숨겼습니다.`);
}

/**
 * 인덱스로 메시지 숨기기
 */
async function hideMessageByIndex(index) {
    try {
        // chat 배열에서 해당 메시지의 is_hidden을 true로 설정
        if (chat && chat[index]) {
            chat[index].is_hidden = true;
            
            // UI 업데이트
            const messageElement = $(`#chat .mes[mesid="${index}"]`);
            if (messageElement.length) {
                messageElement.attr('is_hidden', 'true');
                messageElement.hide(); // 바로 숨기기
            }
            
            // 채팅 저장
            saveChatDebounced();
        }
    } catch (error) {
        console.error('[Broadcast] Error hiding message:', error);
    }
}

/**
 * 메시지 브로드캐스트 실행
 */
async function broadcastMessage(message, autoHide) {
    if (isProcessing) {
        toastr.warning('이미 진행 중입니다.');
        return;
    }
    
    isProcessing = true;
    const delay = extension_settings[extensionName].delayBetweenChats;
    
    toastr.info(`${selectedChats.length}개의 캐릭터에게 메시지를 전송합니다...`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const chatInfo of selectedChats) {
        try {
            await switchToChat(chatInfo);
            
            const currentMsgCount = $('#chat .mes').length;
            
            if (autoHide) {
                pendingHide.set(chatInfo.name, {
                    startIndex: currentMsgCount,
                    waiting: true,
                });
            }
            
            await sendMessage(message);
            
            successCount++;
            
            if (selectedChats.indexOf(chatInfo) < selectedChats.length - 1) {
                await sleep(delay);
            }
        } catch (error) {
            console.error(`[Broadcast] Failed to send to ${chatInfo.name}:`, error);
            failCount++;
        }
    }
    
    isProcessing = false;
    toastr.success(`전송 완료: 성공 ${successCount}, 실패 ${failCount}`);
}

/**
 * 채팅 전환
 */
async function switchToChat(chatInfo) {
    let element;
    
    if (chatInfo.isGroup && chatInfo.grid) {
        // 그룹 선택
        element = $(`.group_select[grid="${chatInfo.grid}"]`);
    } else if (chatInfo.chid) {
        // 캐릭터 선택
        element = $(`.character_select[chid="${chatInfo.chid}"]`);
    } else {
        // 이름으로 찾기
        element = $(`.character_select`).filter(function() {
            return $(this).find('.ch_name').text().trim() === chatInfo.name;
        });
    }
    
    if (element && element.length > 0) {
        element.trigger('click');
        await sleep(1000); // 채팅 로드 대기
    } else {
        throw new Error(`Character not found: ${chatInfo.name}`);
    }
}

/**
 * 메시지 전송
 */
async function sendMessage(message) {
    const textarea = $('#send_textarea');
    textarea.val(message);
    $('#send_but').trigger('click');
    await waitForResponse();
}

/**
 * 응답 대기
 */
function waitForResponse() {
    return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
            if (!$('#send_but').hasClass('disabled') && !$('.mes_generating').length) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
        
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 60000);
    });
}

/**
 * 응답 완료 시 자동 숨김 처리
 */
function handleMessageReceived() {
    const currentChatId = getCurrentChatId();
    
    if (pendingHide.has(currentChatId)) {
        const hideInfo = pendingHide.get(currentChatId);
        
        if (hideInfo.waiting) {
            hideInfo.waiting = false;
            
            const messages = $('#chat .mes');
            const lastIndex = messages.length - 1;
            
            setTimeout(async () => {
                await hideMessageByIndex(lastIndex);
                await hideMessageByIndex(lastIndex - 1);
                pendingHide.delete(currentChatId);
            }, 500);
        }
    }
}

/**
 * 현재 채팅 ID 가져오기
 */
function getCurrentChatId() {
    return window.chat_file_name || 'unknown';
}

/**
 * 슬립 함수
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extensions 메뉴에 버튼 추가
 */
function addBottomButtons() {
    // 기존 버튼 제거
    $('#broadcast_wand_container').remove();
    
    // Extensions 메뉴에 추가
    const buttonHtml = `
        <div id="broadcast_wand_container" class="extension_container interactable" tabindex="0">
            <div id="broadcast-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
                <div class="fa-solid fa-bullhorn extensionsMenuExtensionButton"></div>
                <span>브로드캐스트</span>
            </div>
            <div id="hide-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">
                <div class="fa-solid fa-eye-slash extensionsMenuExtensionButton"></div>
                <span>메시지 숨기기</span>
            </div>
        </div>
    `;
    
    $('#extensionsMenu').prepend(buttonHtml);
    
    // 이벤트 바인딩
    $('#broadcast-btn').on('click', openChatSelector);
    $('#hide-btn').on('click', openHideModal);
    
    console.log('[Broadcast] Buttons added to Extensions menu');
}

/**
 * 확장 프로그램 초기화
 */
jQuery(async () => {
    console.log('[Broadcast] Extension loading...');
    
    loadSettings();
    
    // DOM이 완전히 로드된 후 버튼 추가
    setTimeout(() => {
        addBottomButtons();
    }, 1000);
    
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    
    console.log('[Broadcast] Extension loaded successfully!');
});
