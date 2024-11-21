import { db, auth } from './firebase_config.js';
import { collection, getDocs, doc, getDoc, setDoc, query, where } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

let currentQuestion = 0;
let questions = [];
let currentSubject = '';
let userAnswers = {};
let currentUser = null;
let completedSubjects = [];
let subjectList = [];
let currentSubjectPage = 0;
let subjectsPerPage = 6;
let timerInterval;
let timerElement;
let examStarted = false;
let examStartTime;
let examInProgress = false;
let examEndTime;

// Show loading overlay initially
const loadingOverlay = document.getElementById('loading-overlay');

// Disable right-click and copy
document.addEventListener('contextmenu', (e) => {
    if (examStarted) {
        e.preventDefault();
    }
}); 

document.addEventListener('copy', (e) => {
    if (examStarted) {
        e.preventDefault(); 
    }
});

// Disable text selection
document.addEventListener('selectstart', (e) => {
    if (examStarted) {
        e.preventDefault();
    }
});



// Check authentication state
onAuthStateChanged(auth, async (user) => {
    if (user) {
        currentUser = user;
        document.getElementById('user-email').textContent = user.email;

        // Get exam schedule for user
        try {
            const freshmenQuery = query(collection(db, 'freshmen_examinees'), where('email', '==', user.email));
            const transfereeQuery = query(collection(db, 'transferee_examinees'), where('email', '==', user.email));
            
            const [freshmenDocs, transfereeDocs] = await Promise.all([
                getDocs(freshmenQuery),
                getDocs(transfereeQuery)
            ]);

            let examineeData;
            if (!freshmenDocs.empty) {
                examineeData = freshmenDocs.docs[0].data();
            } else if (!transfereeDocs.empty) {
                examineeData = transfereeDocs.docs[0].data();
            }

            if (examineeData) {
                const today = new Date();
                const examDate = new Date(examineeData.examDate);
                const [endHour, endMinute] = examineeData.examEndTime.split(':');
                examEndTime = new Date(examDate);
                examEndTime.setHours(parseInt(endHour), parseInt(endMinute), 0);

                // If exam end time has passed, mark all as completed
                if (today > examEndTime) {
                    await loadSubjects();
                    await markAllSubjectsAsCompleted();
                    showCompletionMessage();
                    loadingOverlay.style.display = 'none';
                    return;
                }

                // Set interval to check end time
                setInterval(async () => {
                    if (new Date() > examEndTime) {
                        await handleExamTimeout();
                    }
                }, 1000);
            }
        } catch (error) {
            console.error("Error checking exam schedule:", error);
        }

        await loadSubjects();
        await loadUserProgress();
        await loadUserAnswers();
        
        // Check if all subjects are completed
        const allCompleted = subjectList.every(subject => completedSubjects.includes(subject.name.toLowerCase()));
        
        if (allCompleted) {
            showCompletionMessage();
        } else {
            await markIncompleteSubjects();
            checkExamProgress();
            
            // Check if there's a saved timer state
            const savedTimerState = localStorage.getItem('examTimer');
            if (savedTimerState) {
                const {subject, startTime} = JSON.parse(savedTimerState);
                if (subject === currentSubject) {
                    examStartTime = startTime;
                    examStarted = true;
                    examInProgress = true;
                    document.getElementById('logout-btn').disabled = true;
                    startExam();
                }
            }
        }
        
        // Hide loading overlay after everything is loaded
        loadingOverlay.style.display = 'none';
    } else {
        window.location.href = './login.html';
    }
});

async function markAllSubjectsAsCompleted() {
    const userDocRef = doc(db, "EntranceExam", currentUser.email);
    const userDocSnap = await getDoc(userDocRef);
    const existingData = userDocSnap.exists() ? userDocSnap.data() : {};
    const existingCompletedSubjects = existingData.completedSubjects || [];

    // Create ordered completed subjects array based on subjectList order
    const orderedCompletedSubjects = subjectList
        .map(subject => subject.name.toLowerCase())
        .filter(subjectName => !existingCompletedSubjects.includes(subjectName));

    // Preserve existing answers for subjects that have them
    for (const subjectName of orderedCompletedSubjects) {
        const docRef = doc(db, "EntranceExamQuestion", subjectName);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const questions = Object.keys(docSnap.data());
            
            // Check if user has existing answers for this subject
            const existingAnswers = existingData[subjectName] || {};
            const finalAnswers = {};
            
            questions.forEach(qNum => {
                finalAnswers[qNum] = existingAnswers[qNum] || ""; // Keep existing answer or use empty string
            });
            
            // Update user answers for this subject
            await setDoc(userDocRef, {
                [subjectName]: finalAnswers,
                completedSubjects: [...existingCompletedSubjects, subjectName]
            }, { merge: true });
        }
    }
    
    // Update local completedSubjects array
    const updatedUserDoc = await getDoc(userDocRef);
    if (updatedUserDoc.exists()) {
        completedSubjects = updatedUserDoc.data().completedSubjects || [];
    }
}

async function markIncompleteSubjects() {
    for (const subject of subjectList) {
        if (!completedSubjects.includes(subject.name.toLowerCase())) {
            const docRef = doc(db, "EntranceExamQuestion", subject.name.toLowerCase());
            const docSnap = await getDoc(docRef);
            if (docSnap.exists()) {
                const questions = Object.keys(docSnap.data());
                const userAnswersRef = doc(db, "EntranceExam", currentUser.email);
                const userAnswersSnap = await getDoc(userAnswersRef);
                const userAnswersData = userAnswersSnap.exists() ? userAnswersSnap.data() : {};
                const subjectAnswers = userAnswersData[subject.name.toLowerCase()] || {};
                
                if (Object.keys(subjectAnswers).length > 0 && 
                    Object.keys(subjectAnswers).length < questions.length) {
                    questions.forEach(qNum => {
                        if (!subjectAnswers[qNum]) {
                            subjectAnswers[qNum] = "";
                        }
                    });
                    await setDoc(userAnswersRef, {
                        [subject.name.toLowerCase()]: subjectAnswers
                    }, { merge: true });
                } else if (Object.keys(subjectAnswers).length === 0) {
                    const emptyAnswers = {};
                    questions.forEach(qNum => {
                        emptyAnswers[qNum] = "";
                    });
                    await setDoc(userAnswersRef, {
                        [subject.name.toLowerCase()]: emptyAnswers
                    }, { merge: true });
                }
            }
        }
    }
}

async function handleExamTimeout() {
    examInProgress = false;
    examStarted = false; // Added this line to ensure examStarted is also set to false
    clearInterval(timerInterval);
    localStorage.removeItem('examTimer');

    // Save current answers before timeout
    if (currentSubject && questions.length > 0) {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        const existingData = userDocSnap.exists() ? userDocSnap.data() : {};

        // Create a copy of existing data to avoid modifying it directly
        const updatedData = {...existingData};
        
        // Preserve all existing answers for all subjects
        for (const subject of subjectList) {
            const subjectName = subject.name.toLowerCase();
            const existingAnswers = existingData[subjectName] || {};
            
            if (subjectName === currentSubject) {
                // For current subject, merge existing answers with current answers
                updatedData[subjectName] = {
                    ...existingAnswers,
                    ...userAnswers
                };
            } else {
                // For other subjects, keep existing answers unchanged
                updatedData[subjectName] = existingAnswers;
            }
        }

        // Update completedSubjects array
        const orderedSubjects = subjectList.map(subject => subject.name.toLowerCase());
        updatedData.completedSubjects = orderedSubjects;

        // Save all data in one operation
        await setDoc(userDocRef, updatedData);
    }
    
    // Show timeout message
    const timeoutModal = document.getElementById('timeout-modal');
    timeoutModal.style.display = 'flex';
    
    // Redirect after timeout
    setTimeout(async () => {
        timeoutModal.style.display = 'none';
        await signOut(auth);
        window.location.href = './login.html';
    }, 2000);
}

function startCountdown() {
    if (!examStartTime) {
        examStartTime = Date.now();
    }
    
    if (!timerElement) {
        timerElement = document.createElement('div');
        timerElement.id = 'timer';
        timerElement.style.cssText = 'font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem; text-align: center;';
        document.querySelector('.question-container').insertBefore(timerElement, document.querySelector('.question-container .progress-container'));
    }

    if (timerInterval) {
        clearInterval(timerInterval);
    }

    timerInterval = setInterval(async () => {
        const now = new Date();
        const diff = examEndTime - now;

        if (diff <= 0) {
            clearInterval(timerInterval);
            await handleExamTimeout();
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        timerElement.textContent = `Time Remaining: ${hours}h ${minutes}m ${seconds}s`;

        localStorage.setItem('examTimer', JSON.stringify({
            subject: currentSubject,
            startTime: examStartTime
        }));

    }, 1000);
}

async function handleTimeOut() {
    examInProgress = false;
    examStarted = false; // Added this line to ensure examStarted is also set to false
    
    // Save current answers before timeout
    const userDocRef = doc(db, "EntranceExam", currentUser.email);
    const userDocSnap = await getDoc(userDocRef);
    const existingData = userDocSnap.exists() ? userDocSnap.data() : {};
    
    // Create updated data object with all existing answers
    const updatedData = {...existingData};
    
    // Update current subject answers while preserving others
    updatedData[currentSubject] = {
        ...existingData[currentSubject],
        ...userAnswers
    };
    
    // Save all data
    await setDoc(userDocRef, updatedData);
    
    // Show timeout modal
    const timeoutModal = document.getElementById('timeout-modal');
    timeoutModal.style.display = 'flex';
    
    // Wait 2 seconds then automatically proceed
    setTimeout(async () => {
        timeoutModal.style.display = 'none';
        localStorage.removeItem('examTimer');
        await saveUserAnswers();
        await finishExam();
    }, 2000);
}async function loadSubjects() {
    try {
        const querySnapshot = await getDocs(collection(db, "subjectlist"));
        subjectList = [];
        querySnapshot.forEach((doc) => {
            subjectList.push({
                id: doc.id,
                ...doc.data()
            });
        });

        // Sort subjects to ensure mathematics is first if it exists
        subjectList.sort((a, b) => {
            if(a.name.toLowerCase() === 'mathematics') return -1;
            if(b.name.toLowerCase() === 'mathematics') return 1;
            return 0;
        });

        // Set initial current subject
        if(subjectList.length > 0) {
            currentSubject = subjectList[0].name.toLowerCase();
        }

         updateSubjectListUI();

    } catch (error) {
        console.error("Error loading subjects:", error);
    }
}

function updateSubjectListUI() {
    const startIndex = currentSubjectPage * subjectsPerPage;
    const endIndex = startIndex + subjectsPerPage;
    const visibleSubjects = subjectList.slice(startIndex, endIndex);
    
    const subjectListElement = document.getElementById('subject-list');
    subjectListElement.innerHTML = visibleSubjects.map(subject => `
        <li class="subject-item ${subject.name.toLowerCase() === currentSubject ? 'active' : ''} 
            ${completedSubjects.includes(subject.name.toLowerCase()) ? 'completed' : ''}" 
            id="${subject.name.toLowerCase()}">
            ${subject.name} 
            ${subject.name.toLowerCase() === currentSubject && !completedSubjects.includes(subject.name.toLowerCase()) ? '<i class="fas fa-spinner fa-spin"></i>' : ''}
            ${completedSubjects.includes(subject.name.toLowerCase()) ? '<i class="fas fa-check-circle"></i>' : ''}
        </li>
    `).join('');
}

function checkExamProgress() {
    const startSection = document.getElementById('start-exam-section');
    const continueSection = document.getElementById('continue-exam-section');
    const remainingSubjectsDiv = document.getElementById('remaining-subjects');
    
    if (completedSubjects.length > 0) {
        startSection.style.display = 'none';
        continueSection.style.display = 'block';
        
        const remainingSubjects = subjectList.filter(subject => 
            !completedSubjects.includes(subject.name.toLowerCase())
        );
        
        remainingSubjectsDiv.innerHTML = remainingSubjects.map(subject => 
            `<div style="margin: 0.5rem 0;">
                • ${subject.name}
            </div>`
        ).join('');
    } else {
        startSection.style.display = 'block';
        continueSection.style.display = 'none';
    }
}

async function loadUserProgress() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            completedSubjects = data.completedSubjects || [];
            
            // Find first incomplete subject
            const nextSubject = subjectList.find(subject => 
                !completedSubjects.includes(subject.name.toLowerCase())
            );
            
            if (nextSubject) {
                currentSubject = nextSubject.name.toLowerCase();
            }
            
            updateSubjectListUI();
        }
    } catch (error) {
        console.error("Error loading user progress:", error);
    }
}

async function loadUserAnswers() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            if (data[currentSubject]) {
                userAnswers = data[currentSubject];
            } else {
                // Initialize empty answers for current subject
                userAnswers = {};
            }
        }
    } catch (error) {
        console.error("Error loading user answers:", error);
    }
}

async function saveUserAnswers() {
    if (!currentUser) return;
    
    try {
        const userDocRef = doc(db, "EntranceExam", currentUser.email);
        const userDocSnap = await getDoc(userDocRef);
        
        let updatedData = {};
        if (userDocSnap.exists()) {
            updatedData = userDocSnap.data();
        }
        
        // Only save answers for current subject
        updatedData[currentSubject] = userAnswers;
        
        await setDoc(userDocRef, updatedData, { merge: true });
        
    } catch (error) {
        console.error("Error saving user answers:", error);
    }
}

function showCompletionMessage() {
    examInProgress = false;
    examStarted = false; // Added this line to ensure examStarted is also set to false
    document.getElementById('questionnaire-content').innerHTML = `
        <div class="instruction-container">
            <h3>Entrance Exam Completed</h3>
            <p>Congratulations! You have completed all sections of the entrance exam.</p>
            <p>Your responses have been recorded.</p>
            <p>You will be automatically logged out in 3 seconds...</p>
        </div>
    `;
    // Hide loading overlay and spinner when exam is complete
    loadingOverlay.style.display = 'none';
    examStarted = false;
    document.getElementById('logout-btn').disabled = false;
    document.getElementById('logout-btn').style.display = 'block';
    localStorage.removeItem('examTimer');
    
    // Auto logout after 3 seconds
    setTimeout(async () => {
        await signOut(auth);
        window.location.href = './login.html';
    }, 3000);
}

window.logout = async function() {
    if (examStarted) {
        alert("You cannot logout while the exam is in progress!");
        return;
    }
    try {
        await signOut(auth);
        localStorage.removeItem('examTimer');
        window.location.href = './login.html';
    } catch (error) {
        console.error("Error signing out:", error);
    }
}

window.checkAuthAndStartExam = function() {
    if (!currentUser) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="auth-error">
                Please log in to start the exam.
            </div>
        `;
        return;
    }
    
    if (completedSubjects.includes(currentSubject)) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="instruction-container">
                <h3>Subject Already Completed</h3>
                <p>You have already completed the ${currentSubject} section.</p>
            </div>
        `;
        return;
    }
    
    examStarted = true;
    examInProgress = true;
    document.getElementById('logout-btn').disabled = true;
    document.getElementById('logout-btn').style.display = 'none';
    startExam();
}

window.startExam = async function() {
    try {
        const docRef = doc(db, "EntranceExamQuestion", currentSubject);
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            // Get all questions and assign random order numbers
            questions = Object.entries(docSnap.data()).map(([num, data]) => ({
                ...data,
                questionNumber: num,
                randomOrder: Math.random() // Add random order value
            }));
            
            // Sort by random order
            questions.sort((a, b) => a.randomOrder - b.randomOrder);
            
            // Remove the random order property as it's no longer needed
            questions = questions.map(({randomOrder, ...rest}) => rest);
            
            showQuestion(0);
            startCountdown();
        }
    } catch (error) {
        console.error("Error loading questions:", error);
    }
}

function showQuestion(index) {
    const content = document.getElementById('questionnaire-content');
    const question = questions[index];
    const progress = ((index + 1) / questions.length) * 100;
    
    let navigationButtons = '';
    if (index === 0) {
        navigationButtons = '<button class="nav-button" onclick="validateAndNext()">Next</button>';
    } else if (index === questions.length - 1) {
        navigationButtons = `
            <button class="nav-button" onclick="previousQuestion()">Back</button>
            <button class="nav-button" onclick="validateAndFinish()">Finish</button>
        `;
    } else {
        navigationButtons = `
            <button class="nav-button" onclick="previousQuestion()">Back</button>
            <button class="nav-button" onclick="validateAndNext()">Next</button>
        `;
    }

    content.innerHTML = `
        <div class="question-container">
            <div class="progress-container">
                <div class="progress-bar" style="width: ${progress}%">
                    <div class="progress-text">${Math.round(progress)}%</div>
                </div>
            </div>
            <p>${question.question}</p>
            <div class="error-message" id="error-message">
                Please select an answer before proceeding
            </div>
            <div class="options-container">
                ${Object.entries(question.options).map(([key, value]) => `
                    <div class="option-item">
                        <input type="radio" name="answer" value="${key}" id="option${key}" 
                            ${userAnswers[question.questionNumber] === key ? 'checked' : ''}>
                        <label for="option${key}">${value}</label>
                    </div>
                `).join('')}
            </div>
            <div class="navigation">
                ${navigationButtons}
            </div>
        </div>
    `;

    // Preserve timer element when showing new question
    if (timerElement) {
        document.querySelector('.question-container').insertBefore(timerElement, document.querySelector('.question-container .progress-container'));
    }
}

window.validateAndNext = async function() {
    const selectedAnswer = document.querySelector('input[name="answer"]:checked');
    const errorMessage = document.getElementById('error-message');
    const nextButton = document.querySelector('button.nav-button:last-child');
    
    if (!selectedAnswer) {
        errorMessage.style.display = 'block';
        return;
    }
    
    errorMessage.style.display = 'none';
    nextButton.classList.add('loading');
    
    userAnswers[questions[currentQuestion].questionNumber] = selectedAnswer.value;
    await saveUserAnswers();

    currentQuestion++;
    showQuestion(currentQuestion);
}

window.validateAndFinish = async function() {
    const selectedAnswer = document.querySelector('input[name="answer"]:checked');
    const errorMessage = document.getElementById('error-message');
    const finishButton = document.querySelector('button.nav-button:last-child');
    
    if (!selectedAnswer) {
        errorMessage.style.display = 'block';
        return;
    }
    
    errorMessage.style.display = 'none';
    finishButton.classList.add('loading');
    
    userAnswers[questions[currentQuestion].questionNumber] = selectedAnswer.value;
    
    // Check if all questions are answered
    const allQuestionsAnswered = questions.every(q => userAnswers[q.questionNumber]);
    
    if (!allQuestionsAnswered) {
        alert("Please answer all questions before finishing this subject");
        return;
    }
    
    clearInterval(timerInterval);
    localStorage.removeItem('examTimer');
    await saveUserAnswers();
    
    // Only mark as completed if all questions are answered
    const userDocRef = doc(db, "EntranceExam", currentUser.email);
    await setDoc(userDocRef, {
        completedSubjects: [...completedSubjects, currentSubject]
    }, { merge: true });
    
    completedSubjects = [...completedSubjects, currentSubject];
    updateSubjectListUI(); // Update UI immediately after marking subject as completed
    await finishExam();
}

window.previousQuestion = function() {
    currentQuestion--;
    showQuestion(currentQuestion);
}

window.startNextSubject = function(subject) {
    if (completedSubjects.includes(subject)) {
        const content = document.getElementById('questionnaire-content');
        content.innerHTML = `
            <div class="instruction-container">
                <h3>Subject Already Completed</h3>
                <p>You have already completed the ${subject} section.</p>
            </div>
        `;
        return;
    }
    
    currentSubject = subject;
    currentQuestion = 0;
    userAnswers = {};
    timerElement = null;
    examStartTime = null;
    localStorage.removeItem('examTimer');
    
    updateSubjectListUI();
    loadUserAnswers().then(() => startExam());
}

async function finishExam() {
    examInProgress = false;
    
    // Get next incomplete subject
    const nextSubject = subjectList.find(subject => 
        !completedSubjects.includes(subject.name.toLowerCase())
    );

    if (nextSubject) {
        // Automatically start next subject
        currentSubject = nextSubject.name.toLowerCase();
        currentQuestion = 0;
        userAnswers = {};
        timerElement = null;
        examStartTime = null;
        localStorage.removeItem('examTimer');
        updateSubjectListUI();
        await loadUserAnswers();
        startExam();
    } else {
        showCompletionMessage();
        examStarted = false;
        document.getElementById('logout-btn').disabled = false;
        document.getElementById('logout-btn').style.display = 'block';
    }
} 
